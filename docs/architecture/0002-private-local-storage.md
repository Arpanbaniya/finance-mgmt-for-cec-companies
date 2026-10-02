# Private local S3 storage

Use pinned RustFS 1.0.0 for development and isolated storage tests. It supplies a real persistent S3-compatible service on Windows x64 and Linux x64 without Docker or a paid provider. The installer checks the official release archive SHA-256 before extracting/executing it. Downloads, binary, data and generated credentials remain ignored.

The local service binds exclusively to loopback, disables its console, refuses production execution and checks that its port is free. Setup generates random credentials; repeated setup preserves all existing credentials. The SDK configuration rejects plain HTTP except local development, credentials embedded in URLs and loopback endpoints in Vercel/production.

The service is infrastructure, not a released evidence workflow. Anonymous access is denied and temporary object access supports signature checks, expiry and attachment disposition. K024 still needs file-content validation, quarantine/scan states, owner authorization, retention and permissions at download time. No document route or live-evidence release is enabled by this change. Root credentials are local-only; hosted storage requires separate least-privileged credentials and reviewed provider configuration.

References:

- [RustFS Windows installation](https://docs.rustfs.com/en/installation/windows)
- [Pinned official release and asset checksums](https://github.com/rustfs/rustfs/releases/tag/1.0.0)
- [AWS JavaScript S3 examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html)
