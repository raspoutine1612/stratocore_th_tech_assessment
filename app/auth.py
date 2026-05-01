"""
Authentication module.

Reads user records from DynamoDB and verifies passwords with bcrypt.
The DynamoDB table name is injected at runtime via the DYNAMO_TABLE_NAME
environment variable, set by the ECS task definition or Lambda configuration.
"""

import os

import bcrypt
import boto3
from botocore.exceptions import ClientError
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

_security = HTTPBasic()

_dynamodb = boto3.resource("dynamodb", region_name=os.environ["AWS_REGION"])
_table = _dynamodb.Table(os.environ["DYNAMO_TABLE_NAME"])


def _get_user(username: str) -> dict | None:
    """Fetch a user record from DynamoDB. Returns None if the user does not exist."""
    try:
        response = _table.get_item(Key={"username": username})
    except ClientError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable.",
        ) from error

    return response.get("Item")


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

    if user is None or not _verify_password(credentials.password, user["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials.",
            headers={"WWW-Authenticate": "Basic"},
        )

    return credentials.username
