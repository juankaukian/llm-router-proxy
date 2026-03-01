# Contributing

## Development Setup

1. Copy env template:

```bash
cp .env.example .env
```

2. Start stack:

```bash
docker compose up --build
```

## Quality Gates

Before opening a PR, run:

```bash
cd gateway && pnpm test && pnpm typecheck && pnpm lint && pnpm build
cd ../web && pnpm typecheck && pnpm lint && pnpm build
```

## Code Style

- TypeScript strict mode only.
- Keep functions small and explicit.
- Avoid logging secrets.
- Use `pnpm format` before commit.

## Security Guidelines

- Never commit `.env` or credentials.
- Keep Ollama base URL local/private only.
- Prefer least privilege and local-only defaults.
- Report suspected vulnerabilities via private issue/disclosure process.
