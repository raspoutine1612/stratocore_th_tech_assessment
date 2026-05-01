"""
Authentication module.

Reads user records from DynamoDB and verifies passwords with bcrypt.
The DynamoDB table name is injected at runtime via the DYNAMO_TABLE_NAME
environment variable, set by the ECS task definition or Lambda configuration.
"""

import bcrypt
import boto3
import os

from typing import Any
from botocore.exceptions import ClientError
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials


# Dummy hash used when the username does not exist in DynamoDB.
# bcrypt.checkpw is always called to prevent timing-based username enumeration:
# without this, a missing user returns instantly while a wrong password takes ~100ms.
_DUMMY_HASH = bcrypt.hashpw(b"dummy", bcrypt.gensalt()).decode()

_security = HTTPBasic()

_dynamodb = boto3.resource("dynamodb", region_name=os.environ["AWS_REGION"])
_table = _dynamodb.Table(os.environ["DYNAMO_TABLE_NAME"])


def _get_user(username: str) -> dict[str, Any] | None:
    """Fetch a user record from DynamoDB. Returns None if the user does not exist."""
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
    """Return True if plain_password matches the stored bcrypt hash."""
    return bcrypt.checkpw(plain_password.encode(), password_hash.encode())


def require_authenticated_user(
    credentials: HTTPBasicCredentials = Depends(_security),
) -> str:
    """
    FastAPI dependency. Verifies HTTP Basic Auth credentials against DynamoDB.

    Returns the authenticated username on success.
    Raises HTTP 401 on invalid credentials.
    """
    user = _get_user(credentials.username)

    # Always run bcrypt — even when the user does not exist — to prevent
    # timing-based username enumeration. A dummy hash is used in that case.
    stored_hash = user["password_hash"] if user is not None else _DUMMY_HASH
    password_valid = _verify_password(credentials.password, stored_hash)

    if user is None or not password_valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials.",
            headers={"WWW-Authenticate": "Basic"},
        )

    return credentials.username
