FROM python:3.12-slim-bookworm

# FFmpeg es requisito de la tool de extracción visual (plan §3.3).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      curl \
      build-essential \
  && rm -rf /var/lib/apt/lists/*

# uv para install rápido.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

COPY pyproject.toml /app/
RUN uv pip install --system --compile-bytecode -e .

COPY app /app/app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
