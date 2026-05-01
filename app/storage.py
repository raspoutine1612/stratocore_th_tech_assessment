"""
S3 storage module.

All file paths are scoped to the authenticated user: files/{username}/{filename}.
The bucket name is injected at runtime via the S3_BUCKET_NAME environment variable,
set by the ECS task definition or Lambda configuration.
"""

import os

import boto3
from botocore.exceptions import ClientError
from fastapi import HTTPException, status

_s3 = boto3.client("s3", region_name=os.environ["AWS_REGION"])
_bucket = os.environ["S3_BUCKET_NAME"]


def _object_key(username: str, filename: str) -> str:
    """Build the S3 object key for a given user and filename."""
    return f"files/{username}/{filename}"


def upload_file(username: str, filename: str, content: bytes) -> None:
    """Upload file content to S3 under the authenticated user's prefix."""
    try:
        _s3.put_object(
            Bucket=_bucket,
            Key=_object_key(username, filename),
            Body=content,
        )
    except ClientError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Storage service unavailable.",
        ) from error


def list_files(username: str) -> list[str]:
    """
    List all filenames stored under the authenticated user's prefix.

    Paginates through all S3 results — list_objects_v2 returns at most 1000
    objects per call, so we follow NextContinuationToken until exhausted.
    Returns filenames only, not full S3 keys.
    """
    prefix = f"files/{username}/"
    filenames: list[str] = []
    kwargs: dict = {"Bucket": _bucket, "Prefix": prefix}

    while True:
        try:
            response = _s3.list_objects_v2(**kwargs)
        except ClientError as error:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Storage service unavailable.",
            ) from error

        for obj in response.get("Contents", []):
            filenames.append(obj["Key"].removeprefix(prefix))

        if not response.get("IsTruncated"):
            break
        kwargs["ContinuationToken"] = response["NextContinuationToken"]

    return filenames


def delete_file(username: str, filename: str) -> None:
    """
    Delete a file belonging to the authenticated user.

    Raises HTTP 404 if the file does not exist.
    """
    key = _object_key(username, filename)

    # S3 DeleteObject is idempotent — it succeeds even if the key does not exist.
    # We check existence first so we can return a meaningful 404.
    try:
        _s3.head_object(Bucket=_bucket, Key=key)
    except ClientError as error:
        if error.response["Error"]["Code"] == "404":
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"File '{filename}' not found.",
            ) from error
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Storage service unavailable.",
        ) from error

    try:
        _s3.delete_object(Bucket=_bucket, Key=key)
    except ClientError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Storage service unavailable.",
        ) from error
