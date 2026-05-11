#!/bin/bash
set -e

# Configuration
PROJECT_DIR="tiffinset"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
VM_NAME="tiffinset-app"
ZONE="asia-south1-a"

echo "🚀 Starting deployment..."

# 1. Push current code to git
echo "📦 Pushing changes to git..."
git add -A
git commit -m "Deploy: $(date)" || echo "No changes to commit"
git push origin $BRANCH

# 2 & 3. SSH into VM and deploy
echo "🔌 Connecting to GCP VM and deploying..."
gcloud compute ssh $VM_NAME --zone=$ZONE --command "
  cd ~/$PROJECT_DIR && \
  git fetch origin $BRANCH && \
  git reset --hard origin/$BRANCH && \
  npm ci --production && \
  (pm2 restart tiffinset || pm2 start ecosystem.config.cjs --env production) && \
  pm2 save
"

echo "✅ Deployment successful!"
