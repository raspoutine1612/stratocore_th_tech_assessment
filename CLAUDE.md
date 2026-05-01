# CLAUDE.md

Guidelines for this project. Apply these rules to every file generated or modified.

---

## Context

This project is a FastAPI file storage API deployed on AWS using two compute strategies:
- **Target 1** — ECS Fargate (containerized, always-on)
- **Target 2** — AWS Lambda + API Gateway HTTP API (containerized, serverless, scales to zero)

The FastAPI app runs inside a Docker container in both targets. For Lambda, `mangum` adapts the ASGI interface to the Lambda event format. The same ECR image is used by both ECS and Lambda.

Infrastructure is managed with AWS CDK in TypeScript. The developer has a Terraform background and is learning CDK — keep code simple, explicit, and well-commented on CDK-specific patterns the first time they appear.

---

## Code Style

- **Simple and readable first.** If a piece of code needs a comment to be understood, rewrite it. Comments explain intent, not what the code does.
- **No clever one-liners.** Prefer explicit over implicit.
- **One responsibility per function, per class, per construct.** If it does two things, split it.
- **No dead code.** No commented-out blocks, no unused variables, no leftover TODOs.

---

## Naming

- Names must describe intent, not implementation. `grantReadWrite` not `addS3AndKmsPermissions`.
- Booleans are questions: `enableKeyRotation`, `versioned` — not `keyRotation`, `version`.
- Props interfaces end in `Props`: `FileStorageProps`, `AuthTableProps`.
- Constructs are nouns: `FileStorageConstruct`, `AuthTableConstruct`.
- Avoid abbreviations unless universally understood (`kms`, `iam`, `s3` are fine — `cfg`, `mgr`, `util` are not).

---

## Security

- **No hardcoded secrets.** No passwords, tokens, ARNs, or account IDs in source code. Use SSM Parameter Store.
- **No wildcard IAM actions or resources.** Every grant must be scoped to the exact action and resource needed. `s3:*` or `Resource: *` are forbidden.
- **Encryption at rest is mandatory.** Every storage resource (S3, DynamoDB) uses KMS. Never leave encryption unset.
- **Enforce HTTPS.** S3 buckets must have `enforceSSL: true`. ALB listeners must redirect HTTP to HTTPS.
- **Block all public access on S3 buckets.** `BlockPublicAccess.BLOCK_ALL` always.
- **Principle of least privilege.** Grants go through construct methods (`grantReadWrite`, `grantRead`) rather than manual IAM policy statements.
- **No secrets passed as plain environment variables** to ECS or Lambda. Use SSM Parameter Store references in the task/function definition.
- `AWS_REGION` is injected automatically by the Lambda runtime — never set it manually as an environment variable.
- **Passwords stored as bcrypt hashes** in DynamoDB. Never store plain text.

---

## CDK Constructs

- Constructs own their resources and their defaults. A construct must be usable with zero props and produce a secure, sensible result.
- Props are optional with documented defaults via JSDoc. Required props are the exception.
- Constructs expose resources as `readonly` properties. Internal details are private.
- Grants are methods on the construct — never raw `PolicyStatement` in a stack.
- **Stacks are thin.** They instantiate constructs, write SSM parameters, and nothing else.
- Removal policies default to `RETAIN`. `DESTROY` must be explicitly passed and is only acceptable in development stacks.
- Cross-stack references use **SSM Parameter Store** — never `Fn.importValue`.
- When referencing an ECR repository by ARN from SSM (late-bound value), use `fromRepositoryAttributes` with both `repositoryArn` and `repositoryName` — `fromRepositoryArn` will throw at synth time.

---

## TypeScript

- Strict mode on. No `any`. No unsafe casts.
- Every public method and property has a JSDoc comment.
- Props interfaces are exported alongside their construct.
- No implicit `undefined` — use optional chaining and nullish coalescing explicitly.

---

## Python (FastAPI)

- Type hints on every function signature — input and output.
- No bare `except` clauses. Always catch a specific exception type.
- S3 and DynamoDB logic lives in dedicated modules (`storage.py`, `auth.py`) — never inline in route handlers.
- Passwords are verified with `bcrypt` — never compared as plain strings.
- The `/health` endpoint requires no authentication. All other endpoints require HTTP Basic Auth.
- File paths in S3 follow the pattern `files/{username}/{filename}` — always scoped to the authenticated user.

---

## Local configuration

- `.env` is generated — never edited by hand.
  - Local (LocalStack): `python scripts/generate-env.py`
  - AWS account: `python scripts/generate-env.py --profile <profile>`
- `.env` is gitignored. `.env.example` is the committed reference and must be kept in sync with `LOCAL_DEFAULTS` in `scripts/generate-env.py`.
- AWS credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) are never stored in `.env` — use AWS CLI profiles (`aws configure --profile <name>`).
- Environments are managed via AWS accounts, not environment name flags. There is no `--env` parameter.
- Non-sensitive config (`AWS_REGION`, bucket/table names) lives in SSM Parameter Store under `/file-api/`.
- `APP_VERSION` is set to `local` by default. In CI/CD, GitHub Actions injects the git tag or SHA before running CDK deploy, which stamps the `Version` tag on every AWS resource.
- Sensitive app values (third-party API keys, etc.) live in Secrets Manager — add them to `generate-env.py` if needed.

---

## What to avoid

- No inline `PolicyStatement` in stacks — use construct grant methods.
- No hardcoded resource names — use CDK tokens or props.
- No `console.log` in CDK code.
- No `Fn.importValue` for cross-stack references — use SSM Parameter Store.
- No `any` type in TypeScript.
- No plain string comparison for passwords in Python.
