#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
if [[ ! -s pnpm-lock.yaml ]]; then
  echo 'Production deploy refused: generate and commit a real pnpm-lock.yaml first.' >&2
  exit 1
fi
if [[ -f .env.gcp ]]; then
  # shellcheck disable=SC1091
  source .env.gcp
else
  echo 'No .env.gcp detected; using exported GCP_* environment variables (CI mode).'
fi
required=(
  GCP_PROJECT_ID GCP_REGION GCP_ARTIFACT_REPO GCP_SERVICE_NAME
  GCP_WORKER_POOL GCP_MIGRATE_JOB GCP_SQL_CONNECTION_NAME
  GCP_RUN_SERVICE_ACCOUNT GCP_VPC_NETWORK GCP_VPC_SUBNET
  GCP_ADMIN_TELEGRAM_ID GCP_BOT_TOKEN_SECRET GCP_DATABASE_URL_SECRET
  GCP_WEBHOOK_SECRET_SECRET GCP_METRICS_TOKEN_SECRET
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then echo "Missing $name in .env.gcp" >&2; exit 1; fi
done
command -v gcloud >/dev/null || { echo 'Install Google Cloud CLI first.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Install Python 3 for deployment records.' >&2; exit 1; }

# Pin Secret Manager versions in production for repeatable rollouts.
GCP_BOT_TOKEN_VERSION="${GCP_BOT_TOKEN_VERSION:-1}"
GCP_DATABASE_URL_VERSION="${GCP_DATABASE_URL_VERSION:-1}"
GCP_WEBHOOK_SECRET_VERSION="${GCP_WEBHOOK_SECRET_VERSION:-1}"
GCP_REDIS_URL_VERSION="${GCP_REDIS_URL_VERSION:-1}"
GCP_METRICS_TOKEN_VERSION="${GCP_METRICS_TOKEN_VERSION:-1}"
GCP_SENTRY_DSN_VERSION="${GCP_SENTRY_DSN_VERSION:-1}"
GCP_MIGRATOR_SERVICE_ACCOUNT="${GCP_MIGRATOR_SERVICE_ACCOUNT:-$GCP_RUN_SERVICE_ACCOUNT}"
GCP_MIGRATION_DATABASE_URL_SECRET="${GCP_MIGRATION_DATABASE_URL_SECRET:-$GCP_DATABASE_URL_SECRET}"
GCP_MIGRATION_DATABASE_URL_VERSION="${GCP_MIGRATION_DATABASE_URL_VERSION:-$GCP_DATABASE_URL_VERSION}"
for version in "$GCP_BOT_TOKEN_VERSION" "$GCP_DATABASE_URL_VERSION" "$GCP_WEBHOOK_SECRET_VERSION" "$GCP_REDIS_URL_VERSION" "$GCP_MIGRATION_DATABASE_URL_VERSION" "$GCP_METRICS_TOKEN_VERSION" "$GCP_SENTRY_DSN_VERSION"; do
  if [[ ! "$version" =~ ^[1-9][0-9]*$ ]]; then
    echo 'Production Secret versions must be pinned positive integers.' >&2; exit 1
  fi
done

IMAGE_BASE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${GCP_ARTIFACT_REPO}"
REVISION_TAG="${GITHUB_SHA:-local}-$(date -u +%Y%m%d%H%M%S)"
SOURCE_REVISION="${GITHUB_SHA:-${GCP_SOURCE_REVISION:-local}}"
BOT_IMAGE="${IMAGE_BASE}/grammy-bot:${REVISION_TAG}"
MIGRATION_IMAGE="${IMAGE_BASE}/grammy-migrator:${REVISION_TAG}"
SECRETS="BOT_TOKEN=${GCP_BOT_TOKEN_SECRET}:${GCP_BOT_TOKEN_VERSION},DATABASE_URL=${GCP_DATABASE_URL_SECRET}:${GCP_DATABASE_URL_VERSION},WEBHOOK_SECRET=${GCP_WEBHOOK_SECRET_SECRET}:${GCP_WEBHOOK_SECRET_VERSION},METRICS_TOKEN=${GCP_METRICS_TOKEN_SECRET}:${GCP_METRICS_TOKEN_VERSION}"
GCP_REDIS_ENABLED="${GCP_REDIS_ENABLED:-0}"
SECRET_REMOVALS=()
if [[ "$GCP_REDIS_ENABLED" == 1 ]]; then
  : "${GCP_REDIS_URL_SECRET:?Redis enabled but secret name is missing}"
  SECRETS+=",REDIS_URL=${GCP_REDIS_URL_SECRET}:${GCP_REDIS_URL_VERSION}"
elif [[ "$GCP_REDIS_ENABLED" == 0 ]]; then
  SECRET_REMOVALS+=(--remove-secrets REDIS_URL)
else
  echo 'GCP_REDIS_ENABLED must be 0 or 1.' >&2; exit 1
fi
if [[ -n "${GCP_SENTRY_DSN_SECRET:-}" ]]; then
  SECRETS+=",SENTRY_DSN=${GCP_SENTRY_DSN_SECRET}:${GCP_SENTRY_DSN_VERSION}"
fi
# Validate non-secret runtime policy before injecting into gcloud CLI arguments.
GCP_RATE_LIMIT_PER_MINUTE="${GCP_RATE_LIMIT_PER_MINUTE:-0}"
GCP_FEEDBACK_RETENTION_DAYS="${GCP_FEEDBACK_RETENTION_DAYS:-0}"
for policy in "$GCP_RATE_LIMIT_PER_MINUTE" "$GCP_FEEDBACK_RETENTION_DAYS"; do
  if [[ ! "$policy" =~ ^[0-9]{1,4}$ ]]; then
    echo 'Rate limit and retention policies must be integer strings.' >&2; exit 1
  fi
done
if (( 10#$GCP_RATE_LIMIT_PER_MINUTE > 600 || 10#$GCP_FEEDBACK_RETENTION_DAYS > 3650 )); then
  echo 'Rate limit or retention policy is outside its supported range.' >&2; exit 1
fi
ENV_VARS="BOT_MODE=webhook,WEBHOOK_PATH=/telegram/webhook,LOG_LEVEL=info,ADMIN_TELEGRAM_ID=${GCP_ADMIN_TELEGRAM_ID},RATE_LIMIT_PER_MINUTE=${GCP_RATE_LIMIT_PER_MINUTE},FEEDBACK_RETENTION_DAYS=${GCP_FEEDBACK_RETENTION_DAYS}"
ENV_VARS+=",RELEASE_ID=${REVISION_TAG}"
for name in GCP_SUPPORT_CONTACT GCP_PRIVACY_POLICY_URL; do
  value="${!name:-}"
  if [[ "$value" == *','* || "$value" == *$'\n'* ]]; then echo "$name must not contain commas or newlines." >&2; exit 1; fi
done
ENV_VARS+=",SUPPORT_CONTACT=${GCP_SUPPORT_CONTACT:-},PRIVACY_POLICY_URL=${GCP_PRIVACY_POLICY_URL:-}"

printf 'Building: %s\n' "$BOT_IMAGE"
if [[ -n "${GCP_BOT_IMAGE_DIGEST:-}" && -n "${GCP_MIGRATION_IMAGE_DIGEST:-}" ]]; then
  # Promote exactly the already validated staging artifacts, without rebuilding.
  BOT_IMAGE="$GCP_BOT_IMAGE_DIGEST"
  MIGRATION_IMAGE="$GCP_MIGRATION_IMAGE_DIGEST"
  [[ "$BOT_IMAGE" == *@sha256:* && "$MIGRATION_IMAGE" == *@sha256:* ]] || { echo 'Promotion requires digest image references.' >&2; exit 1; }
  [[ "$SOURCE_REVISION" != local ]] || { echo 'Set GCP_SOURCE_REVISION for a verified local promotion.' >&2; exit 1; }
  gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" --quiet
  for image in "$BOT_IMAGE" "$MIGRATION_IMAGE"; do
    docker pull "$image" >/dev/null
    actual_revision="$(docker inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
    [[ "$actual_revision" == "$SOURCE_REVISION" ]] || { echo 'Image source revision differs from quality-checked commit.' >&2; exit 1; }
  done
else
  [[ -z "${GCP_BOT_IMAGE_DIGEST:-}${GCP_MIGRATION_IMAGE_DIGEST:-}" ]] || { echo 'Provide both staging image digests.' >&2; exit 1; }
  gcloud builds submit . --project "$GCP_PROJECT_ID" --config cloudbuild.yaml \
    --substitutions="_BOT_IMAGE=${BOT_IMAGE},_MIGRATION_IMAGE=${MIGRATION_IMAGE},_SOURCE_REVISION=${SOURCE_REVISION}"
  BOT_IMAGE="$(gcloud artifacts docker images describe "$BOT_IMAGE" --project "$GCP_PROJECT_ID" --format='value(image_summary.fully_qualified_digest)')"
  MIGRATION_IMAGE="$(gcloud artifacts docker images describe "$MIGRATION_IMAGE" --project "$GCP_PROJECT_ID" --format='value(image_summary.fully_qualified_digest)')"
fi
[[ "$BOT_IMAGE" == *@sha256:* && "$MIGRATION_IMAGE" == *@sha256:* ]] || { echo 'Unable to resolve immutable image digests.' >&2; exit 1; }

PREVIOUS_SERVICE_IMAGE="$(gcloud run services describe "$GCP_SERVICE_NAME" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
PREVIOUS_WORKER_IMAGE="$(gcloud run worker-pools describe "$GCP_WORKER_POOL" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
SNAPSHOT_DIR="$(mktemp -d)"
trap 'rm -rf -- "$SNAPSHOT_DIR"' EXIT
gcloud run services describe "$GCP_SERVICE_NAME" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --format=export > "$SNAPSHOT_DIR/service.yaml" 2>/dev/null || true
gcloud run worker-pools describe "$GCP_WORKER_POOL" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --format=export > "$SNAPSHOT_DIR/worker.yaml" 2>/dev/null || true
rollback() {
  trap - ERR
  echo 'Deployment failed. Restoring previous application configurations; migrations remain forward compatible.' >&2
  record_status failed || true
  if [[ -s "$SNAPSHOT_DIR/service.yaml" ]]; then
    gcloud run services replace "$SNAPSHOT_DIR/service.yaml" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --quiet || echo 'HTTP rollback failed; operator action required.' >&2
  fi
  if [[ -s "$SNAPSHOT_DIR/worker.yaml" ]]; then
    gcloud run worker-pools replace "$SNAPSHOT_DIR/worker.yaml" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --quiet || echo 'Worker rollback failed; operator action required.' >&2
  fi
  exit 1
}
trap rollback ERR
record_status() {
  python3 - "$1" <<'PY'
import json, sys
from pathlib import Path
p = Path('deployment-record.json')
data = json.loads(p.read_text()) if p.exists() else {}
data['status'] = sys.argv[1]
p.write_text(json.dumps(data, indent=2))
PY
}
python3 - "$BOT_IMAGE" "$MIGRATION_IMAGE" "$PREVIOUS_SERVICE_IMAGE" "$PREVIOUS_WORKER_IMAGE" "$REVISION_TAG" <<'PY'
import json, sys
json.dump(dict(zip(['botImage', 'migrationImage', 'previousServiceImage', 'previousWorkerImage', 'release'], sys.argv[1:])), open('deployment-record.json', 'w'), indent=2)
PY
record_status prepared

# Schema migrations must finish BEFORE rolling out code that expects new tables.
gcloud run jobs deploy "$GCP_MIGRATE_JOB" \
  --project "$GCP_PROJECT_ID" --region "$GCP_REGION" \
  --image "$MIGRATION_IMAGE" \
  --service-account "$GCP_MIGRATOR_SERVICE_ACCOUNT" \
  --add-cloudsql-instances "$GCP_SQL_CONNECTION_NAME" \
  --set-secrets "DATABASE_URL=${GCP_MIGRATION_DATABASE_URL_SECRET}:${GCP_MIGRATION_DATABASE_URL_VERSION}" \
  --max-retries 0 --tasks 1 --memory 1Gi --quiet

gcloud run jobs execute "$GCP_MIGRATE_JOB" \
  --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --wait --quiet

# Telegram cannot supply Google IAM identity tokens, hence the public URL.
# Only the webhook route handles Telegram updates; grammY checks a secret header.
gcloud run deploy "$GCP_SERVICE_NAME" \
  --project "$GCP_PROJECT_ID" --region "$GCP_REGION" \
  --image "$BOT_IMAGE" --allow-unauthenticated \
  --service-account "$GCP_RUN_SERVICE_ACCOUNT" \
  --add-cloudsql-instances "$GCP_SQL_CONNECTION_NAME" \
  --network "$GCP_VPC_NETWORK" --subnet "$GCP_VPC_SUBNET" \
  --vpc-egress private-ranges-only \
  --update-env-vars "$ENV_VARS" --update-secrets "$SECRETS" "${SECRET_REMOVALS[@]}" \
  --port 3000 --memory 1Gi --cpu 1 \
  --concurrency 10 --max-instances 3 --min-instances 1 \
  --startup-probe 'httpGet.path=/ready,httpGet.port=3000,initialDelaySeconds=0,failureThreshold=24,timeoutSeconds=4,periodSeconds=5' \
  --liveness-probe 'httpGet.path=/live,httpGet.port=3000,initialDelaySeconds=0,failureThreshold=3,timeoutSeconds=2,periodSeconds=15' \
  --readiness-probe 'httpGet.path=/ready,httpGet.port=3000,successThreshold=1,failureThreshold=2,timeoutSeconds=3,periodSeconds=10' \
  --timeout 30 --quiet

# Background jobs MUST NOT be run inside request-driven Cloud Run HTTP instances.
gcloud run worker-pools deploy "$GCP_WORKER_POOL" \
  --project "$GCP_PROJECT_ID" --region "$GCP_REGION" \
  --image "$BOT_IMAGE" --instances 1 \
  --command node --args dist/worker.js \
  --service-account "$GCP_RUN_SERVICE_ACCOUNT" \
  --add-cloudsql-instances "$GCP_SQL_CONNECTION_NAME" \
  --network "$GCP_VPC_NETWORK" --subnet "$GCP_VPC_SUBNET" \
  --vpc-egress private-ranges-only \
  --update-env-vars "$ENV_VARS" --update-secrets "$SECRETS" "${SECRET_REMOVALS[@]}" \
  --memory 1Gi --cpu 1 --quiet

URL="$(gcloud run services describe "$GCP_SERVICE_NAME" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --format='value(status.url)')"
gcloud run jobs deploy "${GCP_SERVICE_NAME}-verify" \
  --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --image "$BOT_IMAGE" \
  --command node --args dist/verify.js --service-account "$GCP_RUN_SERVICE_ACCOUNT" \
  --add-cloudsql-instances "$GCP_SQL_CONNECTION_NAME" --network "$GCP_VPC_NETWORK" --subnet "$GCP_VPC_SUBNET" \
  --vpc-egress private-ranges-only --set-env-vars "$ENV_VARS,PUBLIC_URL=$URL,ALLOW_UNREGISTERED_WEBHOOK=${GCP_BOOTSTRAP:-0}" \
  --set-secrets "$SECRETS" --max-retries 0 --task-timeout 180 --quiet
gcloud run jobs execute "${GCP_SERVICE_NAME}-verify" --project "$GCP_PROJECT_ID" --region "$GCP_REGION" --wait --quiet
if [[ "${GCP_BOOTSTRAP:-0}" == 1 ]]; then record_status bootstrap; else record_status verified; fi
trap - ERR
printf '\nDeployment complete. Service URL: %s\n' "$URL"
printf 'Next: set the Telegram webhook with this URL and your real BotFather token.\n'
printf '  pnpm webhook:set -- %s\n' "$URL"
printf 'Secret values are not printed or retrieved by this script.\n'
if [[ "${GCP_BOOTSTRAP:-0}" == 1 ]]; then echo 'BOOTSTRAP ONLY: register webhook, then execute the verifier again with ALLOW_UNREGISTERED_WEBHOOK=0.'; fi
