#!/bin/bash
set -e

# Configuration
PROJECT_DIR="tiffinset"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
VM_NAME="tiffinset-app"
ZONE="asia-south1-a"

echo "🚀 Starting deployment of branch: $BRANCH"

# 1. Verify clean working tree — never auto-commit during deploy
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ Working tree has uncommitted changes. Commit or stash before deploying."
  exit 1
fi

# 2. Push current branch
echo "📦 Pushing $BRANCH to origin..."
git push origin "$BRANCH"

# 3. SSH into VM and deploy
echo "🔌 Connecting to GCP VM and deploying..."
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --command "
  cd ~/$PROJECT_DIR && \
  git fetch origin $BRANCH && \
  git reset --hard origin/$BRANCH && \
  npm ci --production && \
  (pm2 restart tiffinset || pm2 start ecosystem.config.cjs --env production) && \
  pm2 save
"

echo "✅ Deployment successful!"
