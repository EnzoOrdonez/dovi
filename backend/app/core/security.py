"""Auth single-tenant: validación de X-DOVI-Token contra DOVI_API_KEY."""

import hmac

from fastapi import Header, HTTPException, status

from app.core.config import get_settings


async def verify_api_key(x_dovi_token: str | None = Header(default=None)) -> None:
    """FastAPI dependency. Compara en tiempo constante."""
    expected = get_settings().dovi_api_key
    if not x_dovi_token or not hmac.compare_digest(x_dovi_token, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_api_key")
