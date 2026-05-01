"""DynamoDB-backed HTTP Basic Auth. Table name comes from DYNAMO_TABLE_NAME env var."""

import os
from typing import Any

import bcrypt
import boto3
from botocore.exceptions import ClientError
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials


# Always run bcrypt even when the user doesn't exist — prevents timing-based username enumeration.
_DUMMY_HASH = bcrypt.hashpw(b"dummy", bcrypt.gensalt()).decode()

_security = HTTPBasic()

_dynamodb = boto3.resource("dynamodb", region_name=os.environ["AWS_REGION"])
_table = _dynamodb.Table(os.environ["DYNAMO_TABLE_NAME"])


def _get_user(username: str) -> dict[str, Any] | None:
    """Return the DynamoDB user record, or None if the user doesn't exist."""
    try:
        response = _table.get_item(Key={"username": username})
    except ClientError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable.",
        ) from error

    item: dict[str, Any] | None = response.get("Item")
    return item


def _verify_password(plain_password: str, password_hash: str) -> bool:
    """Return True if the password matches the bcrypt hash."""
    return bcrypt.checkpw(plain_password.encode(), password_hash.encode())


def require_authenticated_user(
    credentials: HTTPBasicCredentials = Depends(_security),
) -> str:
    """FastAPI dependency. Returns the authenticated username or raises HTTP 401."""
    user = _get_user(credentials.username)

    stored_hash = user["password_hash"] if user is not None else _DUMMY_HASH
    password_valid = _verify_password(credentials.password, stored_hash)

    if user is None or not password_valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials.",
            headers={"WWW-Authenticate": "Basic"},
        )

    return credentials.username
