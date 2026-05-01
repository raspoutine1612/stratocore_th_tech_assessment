"""
Local environment initializer.

Creates the S3 bucket and DynamoDB table in LocalStack, then seeds a test user.
Run once via docker-compose before starting the app.

Test credentials:  username=testuser  password=password
"""

import os
from datetime import UTC, datetime

import bcrypt
import boto3
from botocore.exceptions import ClientError

region = os.environ["AWS_REGION"]
endpoint = os.environ["AWS_ENDPOINT_URL"]
bucket_name = os.environ["S3_BUCKET_NAME"]
table_name = os.environ["DYNAMO_TABLE_NAME"]

s3 = boto3.client("s3", endpoint_url=endpoint, region_name=region)
dynamodb = boto3.resource("dynamodb", endpoint_url=endpoint, region_name=region)


def create_bucket() -> None:
    # us-east-1 does not accept a LocationConstraint — all other regions require it.
    kwargs: dict = {"Bucket": bucket_name}
    if region != "us-east-1":
        kwargs["CreateBucketConfiguration"] = {"LocationConstraint": region}

    try:
        s3.create_bucket(**kwargs)
        print(f"Bucket '{bucket_name}' created.")
    except ClientError as error:
        if error.response["Error"]["Code"] == "BucketAlreadyOwnedByYou":
            print(f"Bucket '{bucket_name}' already exists, skipping.")
        else:
            raise


def create_table() -> None:
    try:
        table = dynamodb.create_table(
            TableName=table_name,
            KeySchema=[{"AttributeName": "username", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "username", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        table.wait_until_exists()
        print(f"Table '{table_name}' created.")
    except ClientError as error:
        if error.response["Error"]["Code"] == "ResourceInUseException":
            print(f"Table '{table_name}' already exists, skipping.")
        else:
            raise


def seed_test_user() -> None:
    table = dynamodb.Table(table_name)
    password_hash = bcrypt.hashpw(b"password", bcrypt.gensalt()).decode()
    table.put_item(
        Item={
            "username": "testuser",
            "password_hash": password_hash,
            "created_at": datetime.now(UTC).isoformat(),
        }
    )
    print("Test user created: username=testuser  password=password")


if __name__ == "__main__":
    create_bucket()
    create_table()
    seed_test_user()
    print("Local environment ready.")
