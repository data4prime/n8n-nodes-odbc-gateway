# n8n-nodes-odbc-gateway

An n8n community node to run SQL queries on **multiple RDBMS** (PostgreSQL, MySQL/MariaDB,
SQL Server, Oracle, IBM i / Db2 for i) through the **API Gateway → ODBC/JDBC**.

It replaces the "HTTP Request + Code to split rows" pattern: the node calls the gateway, handles
authentication, and returns **one item per record** with named fields.

## Requirement: the API Gateway component

> **This node requires the companion "API Gateway → ODBC/JDBC" component to be deployed and reachable
> from your n8n instance.** The node never connects to databases directly — it only calls the
> gateway's REST endpoints (`/query`, `/connections`, `/tables`, `/columns`, `/health`). All database
> drivers, connection configuration and credentials live in the gateway. **Without a running gateway
> this node cannot operate.**

The gateway is a separate component. To obtain it or for deployment assistance, contact data4prime
(see [Support](#support)).

## Installation

In n8n: **Settings → Community Nodes → Install** → `n8n-nodes-odbc-gateway`
(requires `N8N_COMMUNITY_PACKAGES_ENABLED=true` on the instance).

## Credentials — *ODBC/JDBC Gateway API*

| Field     | Default                              | Notes                                         |
|-----------|--------------------------------------|-----------------------------------------------|
| Base URL  | `http://host.docker.internal:8000`   | From n8n in Docker, use `host.docker.internal` |
| API Key   | —                                    | Sent in the `X-API-Key` header                |

The **Test** button verifies the credentials against `GET /health`.

## Operations

### Table (interface-driven)
Connection / Schema / Table are dropdowns (populated from the gateway metadata); the SQL is built by
the node for the connection's dialect, with values always sent as bound parameters.

- **Select** — *Output Columns* (empty = all), *Conditions (WHERE)* (column/operator/value, combine
  AND/OR), *Sort*, *Return All*/*Limit*. Output: one item per row.
- **Upsert** — *Match Columns* (keys) + *Values to Send* (column/value). **Portable** strategy:
  runs a SELECT on the match columns, then INSERT (if absent) or UPDATE (if present). Uses only
  standard SQL → works on **any dialect**, with no dependency on `MERGE`/`ON CONFLICT`. The output
  reports the action taken (`inserted` / `updated`).
- **Delete** — *Conditions (WHERE)*; if no condition is set it requires the *Delete All Rows* flag.

> **Upsert — notes**: it is not atomic (SELECT and write are separate statements). The *Match Columns*
> should map to a **unique key**; on a SELECT→INSERT race the node falls back to UPDATE on a
> constraint-violation error (SQLSTATE class 23). Identifier quoting and numeric coercion are handled
> per dialect.

### Query (raw SQL)
- **Execute Query** — runs a SELECT. Output: **one item per record** (fields = columns).
  Disable *Split Rows Into Items* to get the raw response (`columns`/`rows`/`row_count`).
  Enable *Preview* to cap the result at 100 rows for a quick look via the node's *Test step*.
- **Execute Statement** — INSERT/UPDATE/DELETE/DDL. Output: `{ affected_rows, elapsed_ms }`.

Fields: **Connection** (dropdown from `GET /connections`), **SQL**, and under *Options*
**Parameters** (JSON array for `?` placeholders) and **Max Rows**.

### Connection
- **List** — lists the configured connections (one item per connection).
- **List Tables** — lists the database tables/views for a connection (one item per table).
  Options: *Schema*, *Catalog*, *Types* (default `TABLE,VIEW`, `*` for all).

### System
- **Health** — gateway status.

## Example
Table → Select on `dbo.Customers` (connection `test_SQLServer`) returning the `CustomerCode` and
`CustomerDescription` columns → N items, each `{ CustomerCode, CustomerDescription }`.

## Development

```bash
npm install
npm run build      # tsc + copy icons into dist/
npm run lint       # community node lint
```

Local testing with n8n in Docker: mount a host folder as `~/.n8n/custom` in the container and
`npm link` the built package, or `npm pack` and install the tarball.

## Publishing (public npm)

### Manual
```bash
npm login
npm version patch
npm publish --access public
```

### Automated (GitHub Actions)
The `.github/workflows/publish.yml` workflow publishes to npm on every `vX.Y.Z` tag (it checks that
the tag matches the `package.json` version).

One-time prerequisite: add the **`NPM_TOKEN`** secret to the repo (Settings → Secrets and variables →
Actions) with an npm **Automation token**.

Release:
```bash
npm version patch          # creates the commit + vX.Y.Z tag
git push --follow-tags     # pushing the tag triggers publishing
```

## Support

For any needs, contact **data4prime** — [www.data4prime.com](https://www.data4prime.com).

## License
MIT
