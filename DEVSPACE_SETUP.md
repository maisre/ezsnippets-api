# DevSpace Setup Guide for ez-api

This guide will help you run and debug the ez-api NestJS application in your local Kubernetes cluster using DevSpace.

## Prerequisites

1. **Docker Desktop** - Installed and running with Kubernetes enabled
   - Open Docker Desktop Settings
   - Go to Kubernetes section
   - Check "Enable Kubernetes"
   - Click "Apply & Restart"

2. **DevSpace CLI** - Install if not already installed:
   ```bash
   # macOS
   brew install devspace

   # Or using curl
   curl -s -L "https://github.com/loft-sh/devspace/releases/latest" | sed -nE 's!.*"([^"]*devspace-darwin-amd64)".*!https://github.com\1!p' | xargs -n 1 curl -L -o devspace && chmod +x devspace && sudo mv devspace /usr/local/bin
   ```

3. **kubectl** - Should be installed with Docker Desktop
   ```bash
   kubectl version --client
   ```

## Quick Start

### 1. Verify Kubernetes Context

Make sure you're using the Docker Desktop Kubernetes context:

```bash
kubectl config get-contexts
kubectl config use-context docker-desktop
```

### 2. Start Development with DevSpace

Navigate to the ez-api directory and run:

```bash
cd /Users/mckay/Projects/ez-snippet/production/ez-api
devspace dev
```

This will:
- Build the Docker image
- Deploy MongoDB to your local cluster
- Deploy the ez-api application
- Set up port forwarding (3000 for API, 9229 for debugging)
- Sync your source code for hot-reloading
- Open http://localhost:3000 in your browser

### 3. Debug in VS Code

Once DevSpace is running, you can attach the debugger:

1. Open the ez-api folder in VS Code
2. Go to the Debug panel (Cmd+Shift+D)
3. Select "Debug in DevSpace" from the dropdown
4. Press F5 or click the green play button

Set breakpoints in your code and they will be hit when requests come in.

Alternatively, if DevSpace is already running:
1. Select "Attach to NestJS" from the debug dropdown
2. Press F5

## DevSpace Commands

### Start Development
```bash
devspace dev
```

### Deploy Without Development Mode
```bash
devspace deploy
```

### Clean Up / Remove Deployments
```bash
devspace purge
```

### View Logs
```bash
devspace logs
```

### Open Terminal in Container
```bash
devspace enter
```

### Reset Everything
```bash
devspace purge
devspace reset pods
```

## File Sync

DevSpace automatically syncs the following:

- `./src` → `/app/src` (with hot-reload, no container restart)
- `./package.json` → `/app/package.json` (runs `npm install` on change)
- `./tsconfig.json` → `/app/tsconfig.json`

Any changes you make to these files locally will be immediately reflected in the container.

## Environment Variables

Environment variables are configured in:
- `k8s/configmap.yaml` - Non-sensitive config (PORT, NODE_ENV, DATABASE_URL)
- `k8s/secret.yaml` - Sensitive data (JWT_SECRET)

To modify them:
1. Edit the respective files
2. Run `devspace deploy` to apply changes
3. Or delete the pod to force recreation: `kubectl delete pod -l app=ez-api`

## MongoDB

MongoDB is automatically deployed and configured:
- Accessible at `mongodb:27017` within the cluster
- Database name: `ez-snippet`
- Data is stored in an emptyDir volume (will be lost on pod deletion)

To persist data across restarts, you can modify `k8s/mongodb-deployment.yaml` to use a PersistentVolumeClaim.

## Troubleshooting

### DevSpace fails to start
```bash
# Check if Kubernetes is running
kubectl get nodes

# Check if context is correct
kubectl config current-context
```

### Port already in use
```bash
# Find and kill process using port 3000
lsof -ti:3000 | xargs kill -9

# Or change the port in devspace.yaml
```

### Image build fails
```bash
# Clean Docker cache
docker system prune -a

# Rebuild from scratch
devspace dev --force-build
```

### Cannot connect to MongoDB
```bash
# Check if MongoDB pod is running
kubectl get pods -l app=mongodb

# Check MongoDB logs
kubectl logs -l app=mongodb

# Wait for MongoDB to be ready
kubectl wait --for=condition=ready pod -l app=mongodb --timeout=60s
```

### Hot reload not working
```bash
# Check DevSpace sync status
devspace logs --follow

# Restart DevSpace
devspace purge
devspace dev
```

## Production Build

To test the production build locally:

```bash
devspace deploy --profile production
```

This will build the production Docker image and deploy it without development features.

## Next Steps

- Configure additional environment variables in `k8s/configmap.yaml`
- Set up persistent storage for MongoDB
- Add additional services (Redis, etc.)
- Configure ingress for external access
- Set up CI/CD pipelines

## Useful kubectl Commands

```bash
# View all pods
kubectl get pods

# View all services
kubectl get services

# View pod logs
kubectl logs -f -l app=ez-api

# Describe pod
kubectl describe pod -l app=ez-api

# Execute command in pod
kubectl exec -it <pod-name> -- sh

# Port forward manually
kubectl port-forward svc/ez-api 3000:3000
```
