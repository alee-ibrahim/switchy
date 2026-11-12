# Security

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository's Security tab, not in a public issue. We aim to reply within a week.

Deployment notes:

- Switchy controls cameras and has no built-in login. Run it on a trusted AV network, or with `AUTH_MODE=proxy` behind an authenticating reverse proxy that strips client-supplied identity headers (see `docs/deploy.md`).
- Camera credentials are read from environment variables and never stored in the database.
- The DCen connection is read-only; Switchy never sends commands to the conference system.
