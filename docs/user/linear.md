# Linear

Linear is optional and off by default. T3 Code works without a Linear account.
When enabled, it can deliver issue changes and comments to an existing active
thread on the environment you select.

## Connect an environment

In the web or desktop client, when Settings shows **Setup required**, choose
**Set up Linear** to open and copy the host setup checklist. This setup/copy flow
is not available in the native mobile app; use a web or desktop client to set up
the host for mobile access. The copy contains public placeholders, not credentials
or a verified callback address. Replace them before applying the configuration.
An enabled switch alone does not mean Linear is connected.

For your own installation, register an OAuth app you control and choose its exact
callback address. Environments connected to the same Linear workspace at the same
time must use separate OAuth apps with the current authorization-code/PKCE,
`actor=app` flow. One shared product app cannot provide independent parallel
app-actor connections to that workspace with this flow. Linear's
[OAuth documentation](https://linear.app/developers/oauth-2-0-authentication)
describes the parallel app-token restriction.

For colleagues, a product app owner must provide separately registered apps for
such simultaneous connections, their public client IDs and approved callbacks.
If those do not exist yet, app ownership and callback addresses remain a human
setup decision. Keep each environment's credentials private; do not distribute
personal keys or OAuth tokens. No shared app or callback service is bundled or
provisioned automatically.

The environment owner must register a Linear OAuth app and configure these public
values in the T3 server's launch environment, replacing the example values:

```text
T3CODE_LINEAR_CLIENT_ID=your-public-client-id
T3CODE_LINEAR_REDIRECT_URI=https://your-approved-host.example/api/integrations/linear/oauth/callback
```

Register that exact redirect URI with the Linear app. It must be reachable from
the browser completing Connect; on a remote connection, `localhost` refers to the
browser's machine. Use an approved HTTPS address for remote access. T3 requests
`read` access with `actor=app` and PKCE S256; this flow does not use a client secret
or a shared personal API key.

The environment owner applies those startup values through the installation's
normal deployment procedure. Then return to Linear settings and use **Reload**;
Connect becomes available once the running environment reports that setup is
configured. A callback for sign-in is separate from the optional webhook endpoint
for push. Start with OAuth and **Fetch issue**; no public webhook ingress is needed
for manual delivery.

Open **Settings → Integrations → Linear**, select one environment, enable Linear
and choose **Connect Linear**. Approve access in Linear, then return and reload
the Linear settings. If the authorization tab did not open, use **Continue in
Linear**. Connect stays unavailable when the client ID or callback is missing;
enabling Linear alone does not register an app or create an HTTPS endpoint.

Enter an issue identifier, select an existing T3 project and thread, and choose
**Bind issue**. The connection's workspace and the issue's team and Linear project
constrain the binding. **Fetch issue** requests a manual delivery without needing
a public webhook endpoint. T3 access requires `orchestration:read` to view status,
`settings:write` to configure Linear, and additionally `orchestration:operate` to
bind issues, fetch them or retry delivery.

## Receive changes automatically

For push delivery, separately configure a Linear webhook for Issue and Comment
changes in the connected workspace. Its exact destination path is:

```text
https://your-approved-host.example/api/integrations/linear/events
```

Save that webhook's signing secret in **Webhook signing secret** on the same T3
environment. It is distinct from OAuth credentials. T3 verifies Linear's HMAC
SHA256 signature over the original request bytes and the signed timestamp before
accepting an event. [Linear's webhook documentation](https://linear.app/developers/webhooks)
describes the payload and signing secret. OAuth tokens and the signing secret
remain in the environment's private secret store and are not returned in settings.

The callback and webhook need explicitly configured routing. No cloud service is
required by T3, and enabling this integration does not deploy one. Expose only
the approved integration endpoints through your chosen HTTPS setup; do not make
the general T3 server or SSH public just to receive webhooks.

## Delivery and stopping

- Only an already active, bound thread receives an agent instruction. Idle,
  paused, archived or stopped work is not automatically started. Resume work
  normally in T3 before explicitly retrying a held delivery.
- OFF makes no new Linear requests. Pending deliveries stay disabled after
  re-enabling until explicitly retried. Own replies and duplicate deliveries are
  ignored; deduplication retains up to 100 events for 24 hours. Full queues reject
  new events rather than silently dropping accepted ones.
- Offline failures need an explicit retry. Rejected credentials require Connect
  again; automatic token renewal is not implemented. Disconnect clears the local
  credentials; revoke the app in Linear separately to remove its remote access.
- **Delivered to agent** confirms dispatch, not completed work. T3 does not write
  comments or issue status back to Linear. Comments retain at most 8,000 characters;
  issue context shares a total delivery limit of 24,000 characters.
