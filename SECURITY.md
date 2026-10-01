# Security Policy

## Supported Versions

We release patches for security vulnerabilities for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it by emailing the maintainers directly rather than opening a public issue.

**Please do not report security vulnerabilities through public GitHub issues.**

### Contact Information

- **Email**: [bartek@smykla.com](mailto:bartek@smykla.com)
- **GitHub Security Advisories**: Use the "Security" tab in the relevant repository

### What to Include

Please provide as much information as possible about the vulnerability:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if available)

### Response Timeline

- **Acknowledgment**: We will acknowledge receipt of your vulnerability report within 48 hours
- **Investigation**: We will investigate and validate the reported vulnerability
- **Fix**: We will develop and test a fix
- **Release**: We will release a security update
- **Disclosure**: We will publicly disclose the vulnerability after the fix is released

### Coordinated Disclosure

Please allow time for the vulnerability to be fixed before public disclosure.

## Security Best Practices

When contributing to Smykla Skalski projects:

- Keep dependencies up to date
- Never commit secrets, credentials, or API keys
- Use environment variables for sensitive configuration
- Follow the principle of least privilege
- Review code changes for security implications

## Desktop trust boundary

- Sail starts its own OpenCode v2 server on `127.0.0.1` with an ephemeral port and a generated Basic auth password. It accepts requests from the packaged Tauri origin; development builds also allow the local Vite origin. The URL and password stay in process memory and are not stored in local storage or project files.
- Restarting the owned server stops the previous child process. Closing the app stops the owned child. The app does not connect to an independently running OpenCode server or stop one.
- The desktop window has a restrictive content security policy and only the dialog and app commands needed by the main window. Agent Markdown is rendered as text and safe links; raw HTML and image URLs are not inserted into the page. Mermaid runs in strict mode and its output is displayed as a data image.
- Repository selection resolves to a Git root. Session selection checks that the session belongs to that root. Attachments can be selected outside the repository; selecting one deliberately sends that file to OpenCode with the prompt. The only direct external file read by the app is the bounded `package.json` version check for a locally configured plan-review plugin.
- Permission requests show the action, resources, and any saved patterns before a decision. **Allow always** stores OpenCode's proposed patterns for the project; **Reject** rejects all pending permission requests in that session. OpenCode requires a separate `external_directory` approval for reads or edits outside the active location, but shell directory inference is best effort. Review broad saved approvals and shell patterns before accepting them. See [OpenCode permissions](https://opencode.ai/v2/docs/permissions).

## Acknowledgments

We appreciate the security research community's efforts to responsibly disclose vulnerabilities.
