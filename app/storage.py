"""S3 storage. All keys are scoped to the authenticated user: files/{username}/{filename}."""

import os

import boto3
from botocore.exceptions import ClientError
from fastapi import HTTPException, status

_s3 = boto3.client("s3", region_name=os.environ["AWS_REGION"])
_bucket = os.environ["S3_BUCKET_NAME"]


def _object_key(username: str, filename: str) -> str:
    """Return the S3 key for a user's file."""
    return f"files/{username}/{filename}"


def upload_file(username: str, filename: str, content: bytes) -> None:
    """Write content to S3 under the user's prefix."""
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
    Return all filenames under the user's prefix.

    Paginates via NextContinuationToken — list_objects_v2 caps at 1000 per call.
    """
    prefix = f"files/{username}/"
    filenames: list[str] = []
    kwargs: dict[str, str] = {"Bucket": _bucket, "Prefix": prefix}

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
    """Delete a user's file. Raises HTTP 404 if it doesn't exist."""
    key = _object_key(username, filename)

    # S3 delete is idempotent — head first so we can return a 404 rather than silently succeed.
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
