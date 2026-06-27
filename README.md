# n8n-nodes-odbc-gateway

Community node n8n per eseguire query SQL su **RDBMS multipli** (PostgreSQL, MySQL/MariaDB,
SQL Server, Oracle, IBM i / Db2 for i) tramite l'**API Gateway ODBC/JDBC**.

Sostituisce il pattern "HTTP Request + Code per splittare le righe": il nodo chiama il gateway,
gestisce l'autenticazione e restituisce **un item per record** con i campi nominati.

## Installazione

In n8n: **Settings → Community Nodes → Install** → `n8n-nodes-odbc-gateway`
(richiede `N8N_COMMUNITY_PACKAGES_ENABLED=true`).

## Credenziali — *ODBC/JDBC Gateway API*

| Campo     | Default                          | Note                                            |
|-----------|----------------------------------|-------------------------------------------------|
| Base URL  | `http://host.docker.internal:8000` | Da n8n in Docker usa `host.docker.internal`     |
| API Key   | —                                | Inviata nell'header `X-API-Key`                 |

Il pulsante **Test** verifica le credenziali su `GET /health`.

## Operazioni

### Table (guidate da interfaccia)
Connection / Schema / Table da dropdown (popolati dai metadati del gateway); l'SQL è
costruito dal nodo per il dialetto della connessione, con valori sempre parametrizzati.

- **Select** — *Output Columns* (vuoto = tutte), *Conditions (WHERE)* (colonna/operatore/valore,
  combine AND/OR), *Sort*, *Return All*/*Limit*. Output: un item per riga.
- **Upsert** — *Match Columns* (chiavi) + *Values to Send* (colonna/valore). Strategia **portabile**:
  fa una SELECT sulle match columns e poi esegue INSERT (se assente) o UPDATE (se presente).
  Usa solo SQL standard → funziona su **qualsiasi dialetto**, senza dipendere da `MERGE`/`ON CONFLICT`.
  L'output indica l'azione effettuata (`inserted` / `updated`).
- **Delete** — *Conditions (WHERE)*; se nessuna condizione richiede il flag *Delete All Rows*.

> **Upsert — note**: non è atomico (SELECT e write sono statement separati). Le *Match Columns*
> dovrebbero corrispondere a una **chiave unica**; in caso di race SELECT→INSERT il nodo fa
> fallback a UPDATE sull'errore di vincolo (SQLSTATE classe 23). Quoting identificatori e
> coercizione numerica gestiti per dialetto.

### Query (SQL raw)
- **Execute Query** — esegue una SELECT. Output: **un item per record** (campi = colonne).
  Disattiva *Split Rows Into Items* per ottenere la risposta grezza (`columns`/`rows`/`row_count`).
- **Execute Statement** — INSERT/UPDATE/DELETE/DDL. Output: `{ affected_rows, elapsed_ms }`.

Campi: **Connection** (dropdown popolato da `GET /connections`), **SQL**, e in *Options*
**Parameters** (array JSON per i placeholder `?`) e **Max Rows**.

### Connection
- **List** — elenca le connessioni configurate (un item per connessione).
- **List Tables** — elenca tabelle e viste del DB di una connessione (un item per tabella).
  Opzioni: *Schema*, *Catalog*, *Types* (default `TABLE,VIEW`, `*` per tutti).

### System
- **Health** — stato del gateway.

## Esempio
Execute Query su `test_SQLServer` con `SELECT * FROM dbo.Customers` → N item, ciascuno
`{ CustomerCode, CustomerDescription }`.

## Sviluppo

```bash
npm install
npm run build      # tsc + copia icone in dist/
npm run lint       # lint community node
```

Test locale con n8n in Docker: monta una cartella host come `~/.n8n/custom` nel container e
`npm link` il pacchetto buildato, oppure `npm pack` e installa il tarball.

## Pubblicazione (npm pubblico)

### Manuale
```bash
npm login
npm version patch
npm publish --access public
```

### Automatica (GitHub Actions)
Il workflow `.github/workflows/publish.yml` pubblica su npm a ogni tag `vX.Y.Z`
(verifica che il tag combaci con la versione in `package.json`).

Prerequisito una tantum: aggiungere il secret **`NPM_TOKEN`** nel repo
(Settings → Secrets and variables → Actions) con un **Automation token** npm.

Release:
```bash
npm version patch          # crea il commit + tag vX.Y.Z
git push --follow-tags     # il push del tag avvia la pubblicazione
```

## Licenza
MIT
