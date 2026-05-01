# Runbook — Deploy from Scratch

Step-by-step instructions to bring the full stack up in a fresh AWS account.

---

## Prerequisites

| Tool | Minimum version | Check |
|---|---|---|
| AWS CLI | v2 | `aws --version` |
| Node.js | 18 | `node --version` |
| Docker | any recent | `docker --version` |
| Python | 3.10+ | `python --version` |

Configure an AWS CLI profile with enough permissions to create IAM roles, VPCs, S3 buckets, DynamoDB tables, Lambda functions, ECR repos, ECS clusters, and CloudFormation stacks:

```bash
aws configure --profile stratocore-dev
# AWS Access Key ID: ...
# AWS Secret Access Key: ...
# Default region: us-east-1
# Default output format: json
```

---

## Step 1 — Bootstrap CDK

CDK needs a staging bucket and a set of IAM roles in your account before it can deploy anything. This is a one-time operation per account/region.

```bash
cd cdk
npm install
npx cdk bootstrap aws://YOUR_ACCOUNT_ID/us-east-1 \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
  --profile stratocore-dev
```

Replace `YOUR_ACCOUNT_ID` with your 12-digit AWS account ID.

---

## Step 2 — Create a GitHub CodeConnections connection

The pipeline uses CodeConnections (formerly CodeStar Connections) to pull source from GitHub. This step cannot be automated — AWS requires a manual browser authorization.

1. Open the AWS Console → **CodePipeline → Settings → Connections**
2. Click **Create connection**, choose **GitHub**, name it (e.g. `github-stratocore`)
3. Click **Connect to GitHub** and authorize the AWS app in the GitHub OAuth flow
4. Copy the connection ARN — it looks like:
   `arn:aws:codeconnections:us-east-1:123456789012:connection/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
5. Store it in SSM so the pipeline stack can read it at deploy time:

```bash
aws ssm put-parameter \
  --name /file-api/github-connection-arn \
  --value "arn:aws:codeconnections:us-east-1:YOUR_ACCOUNT_ID:connection/YOUR_CONNECTION_ID" \
  --type String \
  --profile stratocore-dev \
  --region us-east-1
```

---

## Step 3 — Deploy the shared resources

SharedStack creates S3, ECR, DynamoDB, and KMS keys, then writes their ARNs to SSM. All other stacks depend on these SSM values.

```bash
npx cdk deploy file-api-shared --profile stratocore-dev --require-approval never
```

---

## Step 4 — Build and push the Docker image

The ECS and Lambda stacks both reference the ECR image. It must exist before either stack can deploy. The ECR repo URI was written to SSM by the previous step.

```bash
# Retrieve the ECR repo URI
ECR_URI=$(aws ssm get-parameter \
  --name /file-api/ecr-repo-uri \
  --profile stratocore-dev \
  --region us-east-1 \
  --query "Parameter.Value" \
  --output text)

# Authenticate Docker to ECR
aws ecr get-login-password --region us-east-1 --profile stratocore-dev \
  | docker login --username AWS --password-stdin "$ECR_URI"

# Build for Lambda-compatible amd64 (OCI manifest must be Docker schema v2)
docker build \
  --platform linux/amd64 \
  --provenance=false \
  -t "$ECR_URI:latest" \
  ../app

docker push "$ECR_URI:latest"
```

> **Why `--provenance=false`?** Docker BuildKit adds an OCI image index manifest by default.
> Lambda only accepts `application/vnd.docker.distribution.manifest.v2+json` —
> the provenance attestation layer triggers an unsupported format error.

---

## Step 5 — Deploy the network

```bash
npx cdk deploy file-api-network --profile stratocore-dev --require-approval never
```

Creates the VPC (2 AZs, public + private subnets, S3/DynamoDB Gateway Endpoints) and the ALB.

---

## Step 6 — Deploy ECS and Lambda

```bash
npx cdk deploy file-api-ecs    --profile stratocore-dev --require-approval never
npx cdk deploy file-api-lambda --profile stratocore-dev --require-approval never
```

The ECS stack registers the container with the ALB. The Lambda stack creates the function and an API Gateway HTTP API.

Retrieve the endpoints once the stacks are up:

```bash
# Lambda — API Gateway URL
aws ssm get-parameter --name /file-api/lambda-api-url \
  --profile stratocore-dev --region us-east-1 --query "Parameter.Value" --output text

# ECS — ALB DNS name
aws ssm get-parameter --name /file-api/alb-dns \
  --profile stratocore-dev --region us-east-1 --query "Parameter.Value" --output text
```

---

## Step 7 — Deploy the pipeline

```bash
npx cdk deploy file-api-pipeline --profile stratocore-dev --require-approval never
```

From this point on, every push to `main` triggers the pipeline automatically:
1. **Source** — pulls from GitHub
2. **Quality Gate** — lint, type check, SAST, CVE scan (parallel)
3. **Deploy** — ECS rolling update + Lambda `update-function-code`

---

## Step 8 — Create the first user

The DynamoDB `users` table is empty after a fresh deploy. Use this script to seed users with bcrypt-hashed passwords.

```bash
# Install dependencies if not already present
pip install boto3 bcrypt

python - <<'EOF'
import boto3, bcrypt, datetime

TABLE = "file-api-shared-StorageTable8693A1F8-1U1OP0W58UCH"  # replace with actual table name
# Get it from: aws ssm get-parameter --name /file-api/dynamo-table-name ...

session = boto3.Session(profile_name='stratocore-dev', region_name='us-east-1')
table = session.resource('dynamodb').Table(TABLE)

users = [
    ("alice", "changeme"),
    ("bob",   "changeme"),
]

for username, password in users:
    table.put_item(Item={
        "username":      username,
        "password_hash": bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode(),
        "created_at":    datetime.datetime.now(datetime.UTC).isoformat(),
    })
    print(f"Created: {username}")
EOF
```

Retrieve the actual table name dynamically:

```bash
TABLE=$(aws ssm get-parameter \
  --name /file-api/dynamo-table-name \
  --profile stratocore-dev --region us-east-1 \
  --query "Parameter.Value" --output text)
```

---

## Step 9 — Smoke test

```bash
chmod +x tests/test-api.sh

# Lambda
./tests/test-api.sh https://<api-gw-id>.execute-api.us-east-1.amazonaws.com alice:changeme bob:changeme

# ECS
./tests/test-api.sh http://<alb-dns>.us-east-1.elb.amazonaws.com alice:changeme bob:changeme
```

All 13 assertions should pass.

---

## Teardown

> This permanently deletes all data in S3 and DynamoDB.

```bash
# Delete compute stacks first (no data in them)
npx cdk destroy file-api-pipeline --profile stratocore-dev --force
npx cdk destroy file-api-lambda   --profile stratocore-dev --force
npx cdk destroy file-api-ecs      --profile stratocore-dev --force
npx cdk destroy file-api-network  --profile stratocore-dev --force

# Empty the S3 bucket before destroying the shared stack
BUCKET=$(aws ssm get-parameter --name /file-api/bucket-name \
  --profile stratocore-dev --region us-east-1 --query "Parameter.Value" --output text)
aws s3 rm "s3://$BUCKET" --recursive --profile stratocore-dev

npx cdk destroy file-api-shared --profile stratocore-dev --force
```

Log groups are set to `RETAIN` — delete them manually if needed:

```bash
aws logs delete-log-group --log-group-name /file-api/ecs/app    --profile stratocore-dev --region us-east-1
aws logs delete-log-group --log-group-name /file-api/lambda/app --profile stratocore-dev --region us-east-1
```
