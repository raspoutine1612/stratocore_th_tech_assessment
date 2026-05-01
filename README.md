# FastAPI File Storage — AWS Infrastructure

A FastAPI application deployed on AWS using two compute strategies (containerized and serverless), backed by S3 for persistent file storage, user authentication via DynamoDB, and managed through Infrastructure as Code with AWS CDK (TypeScript).

---

## Architecture Overview

```plantuml
@startuml
!define AWSPuml https://raw.githubusercontent.com/awslabs/aws-icons-for-plantuml/v18.0/dist
!include AWSPuml/AWSCommon.puml
!include AWSPuml/NetworkingContentDelivery/ElasticLoadBalancing.puml
!include AWSPuml/Containers/ElasticContainerService.puml
!include AWSPuml/Containers/ElasticContainerRegistry.puml
!include AWSPuml/Compute/Lambda.puml
!include AWSPuml/Storage/SimpleStorageService.puml
!include AWSPuml/Database/DynamoDB.puml
!include AWSPuml/ManagementGovernance/CloudWatch.puml
!include AWSPuml/SecurityIdentityCompliance/IdentityandAccessManagement.puml
!include AWSPuml/DeveloperTools/CodePipeline.puml
!include AWSPuml/DeveloperTools/CodeBuild.puml
!include AWSPuml/ManagementGovernance/SystemsManagerParameterStore.puml

skinparam backgroundColor #FAFAFA
skinparam rectangle {
  BorderColor #666666
  FontColor #333333
}

actor "Client" as client

rectangle "AWS Cloud" {

  rectangle "VPC" {
    rectangle "Public Subnets" {
      ElasticLoadBalancing(alb, "Application Load Balancer", "HTTPS :443")
    }
    rectangle "Private Subnets" {
      ElasticContainerService(ecs, "ECS Fargate\n(FastAPI container)", "Target 1 — Containerized")
    }
  }

  rectangle "Serverless" {
    Lambda(lambda, "Lambda + Mangum\n(FastAPI handler)", "Target 2 — Serverless")
  }

  ElasticContainerRegistry(ecr, "ECR\n(Basic scan on push)", "Docker image registry")
  SimpleStorageService(s3, "S3 Bucket\nfiles/{username}/{filename}", "Persistent storage — KMS encrypted")
  DynamoDB(dynamo, "DynamoDB\nusers table", "Authentication — KMS encrypted")
  CloudWatch(cw, "CloudWatch\nLog Groups", "Application logs")
  IdentityandAccessManagement(iam, "IAM Roles\nTask Role / Lambda Role", "Least privilege")
  SystemsManagerParameterStore(ssm, "SSM Parameter Store", "Cross-stack ARN references")

  rectangle "CI/CD" {
    CodePipeline(pipeline, "CodePipeline", "Three-stage deployment")
    CodeBuild(build, "CodeBuild", "Quality gate + build + deploy")
  }
}

client --> alb : HTTPS (Basic Auth header)
alb --> ecs : Forward (private subnet)
client --> lambda : HTTPS Function URL\n(Basic Auth header)

ecs --> s3 : PutObject / GetObject\nDeleteObject / ListBucket
lambda --> s3 : PutObject / GetObject\nDeleteObject / ListBucket

ecs --> dynamo : GetItem (auth check)
lambda --> dynamo : GetItem (auth check)

ecr --> ecs : Pull image
ecs --> cw : awslogs driver
lambda --> cw : Lambda logs

iam --> ecs : Task role
iam --> lambda : Execution role

pipeline --> build : Trigger on commit
build --> ecr : docker push + ECR scan
build --> ecs : ECS rolling update
build --> lambda : Lambda function update

ssm --> pipeline : ARN cross-stack refs

@enduml
```

---

## Repository Structure

```
.
├── app/
│   ├── main.py            # FastAPI application — route definitions only
│   ├── auth.py            # HTTP Basic Auth + DynamoDB password verification
│   ├── storage.py         # S3 operations (upload, list, delete)
│   ├── Dockerfile
│   └── requirements.txt
├── cdk/
│   ├── bin/
│   │   └── app.ts         # CDK entrypoint — instantiates all stacks in order
│   └── lib/
│       ├── stacks/
│       │   ├── shared-stack.ts    # S3, ECR, DynamoDB + SSM writes
│       │   ├── network-stack.ts   # VPC, ALB, Security Groups
│       │   ├── ecs-stack.ts       # ECS Cluster, Task Definition, Service
│       │   └── lambda-stack.ts    # Lambda Function + Function URL
│       └── constructs/
│           ├── file-storage-construct.ts   # S3 + KMS key
│           ├── auth-table-construct.ts     # DynamoDB users table + KMS key
│           ├── secure-api-construct.ts     # ECS task + ALB wiring
│           └── quality-pipeline-construct.ts # CodePipeline 3 stages
├── buildspec.yml          # CodeBuild specification
├── CLAUDE.md              # Coding guidelines for this project
└── README.md
```

---

## CDK Stack Organization

Cross-stack references are resolved via **SSM Parameter Store**. Each stack is fully independent and can be deployed separately. Stacks are thin — they instantiate constructs and write SSM parameters, nothing else.

### Deployment order

```
SharedStack → NetworkStack → EcsStack → LambdaStack
```

### SharedStack
Creates shared resources and writes their ARNs/names to SSM:
- **S3 Bucket** — KMS encrypted, lifecycle policy, public access blocked, HTTPS enforced
- **ECR Repository** — basic image scan on push enabled
- **DynamoDB Table** — `users` table, KMS encrypted, on-demand billing
- Writes to SSM: `bucket-name`, `bucket-arn`, `ecr-repo-uri`, `dynamo-table-name`, `dynamo-table-arn`

### NetworkStack
Reads from SSM. Creates:
- **VPC** — two Availability Zones, public and private subnets
- **Security Groups** — ALB accepts inbound 443 only; ECS tasks accept inbound from ALB only
- **Application Load Balancer** — internet-facing, HTTP → HTTPS redirect, forwards to ECS target group
- Writes to SSM: `vpc-id`, `alb-arn`, `private-subnet-ids`, `ecs-sg-id`

### EcsStack
Reads from SSM. Creates:
- **ECS Cluster** — Fargate launch type
- **Task Definition** — FastAPI container, `awslogs` driver → CloudWatch
- **ECS Service** — private subnets, registered to ALB target group
- **Task Role** — S3 + DynamoDB permissions via construct grant methods
- **Execution Role** — ECR pull + CloudWatch Logs write

### LambdaStack
Reads from SSM. Creates:
- **Lambda Function** — Python runtime, FastAPI wrapped with Mangum
- **Function URL** — HTTPS, CORS configured
- **Execution Role** — same S3 + DynamoDB permissions as ECS task role

---

## IAM Design

No wildcard actions. No wildcard resources. All grants go through construct methods.

| Role | Principal | Allowed Actions | Scope |
|---|---|---|---|
| ECS Task Role | `ecs-tasks.amazonaws.com` | `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` | Project bucket only |
| ECS Task Role | `ecs-tasks.amazonaws.com` | `dynamodb:GetItem` | Users table only |
| ECS Execution Role | `ecs-tasks.amazonaws.com` | `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `logs:CreateLogStream`, `logs:PutLogEvents` | ECR + CloudWatch scoped |
| Lambda Execution Role | `lambda.amazonaws.com` | `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` | Project bucket only |
| Lambda Execution Role | `lambda.amazonaws.com` | `dynamodb:GetItem` | Users table only |

---

## Authentication

**HTTP Basic Auth** on every endpoint except `/health`.

On each request FastAPI reads the `Authorization` header, fetches the user record from DynamoDB by `username`, and verifies the submitted password against the stored bcrypt hash. Passwords are never stored or compared in plain text.

**DynamoDB `users` table schema:**

| Attribute | Type | Description |
|---|---|---|
| `username` | String (PK) | Unique username |
| `password_hash` | String | bcrypt hash |
| `created_at` | String | ISO 8601 timestamp |

Files are namespaced per user: `files/{username}/{filename}`. A user can only access their own files — enforced at the application level.

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | None | Returns `{"status": "healthy"}` |
| `POST` | `/upload` | Basic Auth | Uploads a file to `files/{username}/{filename}` |
| `GET` | `/files` | Basic Auth | Lists files for the authenticated user |
| `DELETE` | `/files/{filename}` | Basic Auth | Deletes a file belonging to the authenticated user |

> **Lambda payload limit:** 6 MB per request. Files larger than 6 MB must go through the ECS/ALB endpoint.

---

## File Persistence

Files are stored in S3 at `files/{username}/{filename}`. S3 is the single source of truth for both compute targets — restarting or redeploying ECS or Lambda has no impact on stored files.

**Lifecycle policy:**
- Transition to S3 Glacier Instant Retrieval after **90 days**
- Permanent deletion after **365 days**
- Incomplete multipart uploads aborted after **7 days**

---

## CI/CD Pipeline

Three stages. A failure at any stage blocks everything downstream.

```
Source (GitHub / CodeCommit)
    │
    ▼
Stage 1 — Quality Gate
    ├── ruff check              # Lint
    ├── ruff format --check     # Format
    ├── mypy app/               # Type checking
    ├── bandit -r app/          # Python SAST
    ├── pip-audit               # Dependency CVE scan
    └── SonarCloud scan         # Full SAST + code smells
    │
    ▼
Stage 2 — Build & Image Scan
    ├── docker build
    ├── docker push → ECR
    └── Block if CRITICAL or HIGH CVEs found in image
    │
    ▼
Stage 3 — Deploy
    ├── cdk deploy SharedStack
    ├── cdk deploy NetworkStack
    ├── cdk deploy EcsStack     → ECS rolling update
    └── cdk deploy LambdaStack  → Lambda update
```

### Quality tools

| Tool | Category | What it catches |
|---|---|---|
| `ruff check` | Lint | PEP8 violations, unused imports |
| `ruff format --check` | Format | Inconsistent formatting |
| `mypy` | Type checking | Type mismatches, missing annotations |
| `bandit` | SAST | Hardcoded secrets, unsafe calls |
| `pip-audit` | Dependency scan | Known CVEs in requirements.txt |
| SonarCloud | SAST + quality | Code smells, duplications, security hotspots |
| ECR basic scan | Image scan | OS and package CVEs in the Docker image |

---

## Design Decisions

### Why S3 for file persistence?
ECS Fargate tasks are ephemeral — the local filesystem is lost on every restart or redeployment. S3 provides durable object storage accessible identically from ECS and Lambda through IAM roles, with no network configuration required.

### Why DynamoDB for authentication?
- RDS costs ~$15/month minimum for `db.t3.micro`, requires a VPC subnet group, and forces Lambda into the VPC (longer cold starts, ENI management).
- A sidecar database container in ECS requires EFS for persistence and is unreachable from Lambda without extra networking.
- DynamoDB is serverless, zero network config, free at this scale (on-demand, 25 GB + 200M requests/month free tier), and works identically from ECS and Lambda.

### Why SSM Parameter Store for cross-stack references?
`Fn.importValue` (CloudFormation exports) blocks stack updates when another stack depends on an export. SSM decouples stacks entirely — each reads what it needs at synth time and can be deployed independently.

### Why Lambda Function URL instead of API Gateway?
API Gateway adds stage management, integration mapping, and request transformation with no benefit at this scale. A Function URL is a direct HTTPS endpoint with zero additional infrastructure. The trade-off (no built-in rate limiting) is acceptable for this use case.

### Why ECS Fargate instead of EC2?
Fargate removes OS patching and instance sizing. For a stateless API container, pay-per-task is the correct model.

### Why CDK Constructs (L3)?
Constructs encapsulate a resource with its security defaults, lifecycle config, and grant methods in one reusable, testable class — the equivalent of a Terraform module. Stacks stay thin and readable, all logic lives in constructs, and jest unit tests validate the generated CloudFormation without deploying anything.
