"""
Generate .env from AWS SSM Parameter Store.

Environments are managed via AWS accounts, not environment names.
Pass --profile to target a specific account; omit it for local defaults.

AWS credentials are never stored in .env — use AWS CLI profiles instead:
  aws configure --profile stratocore-dev

Usage:
  python scripts/generate-env.py                        # local defaults (LocalStack)
  python scripts/generate-env.py --profile stratocore-dev  # fetch from AWS SSM
"""

import argparse
import sys
from pathlib import Path

LOCAL_DEFAULTS: dict[str, str] = {
    "AWS_REGION": "us-east-1",
    "APP_VERSION": "local",
    "S3_BUCKET_NAME": "file-api-local",
    "DYNAMO_TABLE_NAME": "file-api-users-local",
}

# SSM parameter paths written by SharedStack under the /file-api/ namespace.
SSM_PARAMETERS: dict[str, str] = {
    "AWS_REGION": "/file-api/aws-region",
    "S3_BUCKET_NAME": "/file-api/bucket-name",
    "DYNAMO_TABLE_NAME": "/file-api/dynamo-table-name",
}

ENV_FILE = Path(__file__).parent.parent / ".env"


def write_env(values: dict[str, str]) -> None:
    """Write key=value pairs to .env at the repository root."""
    lines = [f"{key}={value}\n" for key, value in values.items()]
    ENV_FILE.write_text("".join(lines), encoding="utf-8")
    print(f".env written to {ENV_FILE}")
    for key, value in values.items():
        print(f"  {key}={value}")


def fetch_from_ssm(profile: str | None) -> dict[str, str]:
    """Fetch parameter values from SSM Parameter Store."""
    try:
        import boto3
        from botocore.exceptions import ClientError, NoCredentialsError
    except ImportError:
        print("boto3 is required: pip install boto3", file=sys.stderr)
        sys.exit(1)

    session = boto3.Session(profile_name=profile)
    ssm = session.client("ssm")
    values: dict[str, str] = {}

    for key, path in SSM_PARAMETERS.items():
        try:
            response = ssm.get_parameter(Name=path, WithDecryption=True)
            values[key] = response["Parameter"]["Value"]
        except ClientError as error:
            print(f"Failed to fetch SSM parameter '{path}': {error}", file=sys.stderr)
            sys.exit(1)
        except NoCredentialsError:
            print(
                "No AWS credentials found. "
                "Run: aws configure --profile <profile-name>",
                file=sys.stderr,
            )
            sys.exit(1)

    return values


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate .env from SSM or local defaults.")
    parser.add_argument(
        "--profile",
        default=None,
        help="AWS CLI profile name. Omit to write local defaults for LocalStack.",
    )
    args = parser.parse_args()

    if args.profile is None:
        print("No profile given — writing local defaults (LocalStack).")
        write_env(LOCAL_DEFAULTS)
    else:
        print(f"Fetching SSM parameters with profile '{args.profile}'...")
        values = fetch_from_ssm(args.profile)
        write_env(values)


if __name__ == "__main__":
    main()
