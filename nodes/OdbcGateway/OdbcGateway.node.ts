import {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	NodeApiError,
	NodeOperationError,
} from 'n8n-workflow';

import {
	buildDelete,
	buildExists,
	buildInsert,
	buildSelect,
	buildUpdate,
	Dialect,
	SortRule,
	WhereCondition,
} from './dialect';

/** Chiamata HTTP autenticata verso il gateway (header X-API-Key dalla credenziale). */
async function gatewayRequest(
	ctx: IExecuteFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body?: IDataObject,
): Promise<unknown> {
	const credentials = await ctx.getCredentials('odbcGatewayApi');
	const baseUrl = String(credentials.baseUrl ?? '').replace(/\/+$/, '');
	return ctx.helpers.httpRequestWithAuthentication.call(ctx, 'odbcGatewayApi', {
		method,
		url: `${baseUrl}${endpoint}`,
		body,
		json: true,
	});
}

/** Mappa la risposta del gateway (columns + rows) in un item per record con campi nominati. */
function rowsToItems(response: IDataObject, itemIndex: number): INodeExecutionData[] {
	const columns = (response.columns as string[]) ?? [];
	const rows = (response.rows as unknown[][]) ?? [];
	return rows.map((row) => {
		const json: IDataObject = {};
		columns.forEach((col, i) => {
			json[col] = row[i] as IDataObject[string];
		});
		return { json, pairedItem: { item: itemIndex } };
	});
}

/** Restituisce i nomi delle colonne di una tabella dal gateway. */
async function fetchColumns(
	ctx: IExecuteFunctions | ILoadOptionsFunctions,
	connection: string,
	schema: string,
	table: string,
): Promise<IDataObject[]> {
	const qs: string[] = [`table=${encodeURIComponent(table)}`];
	if (schema) qs.push(`schema=${encodeURIComponent(schema)}`);
	const endpoint = `/connections/${encodeURIComponent(connection)}/columns?${qs.join('&')}`;
	const res = (await gatewayRequest(ctx, 'GET', endpoint)) as IDataObject;
	return (res.columns as IDataObject[]) ?? [];
}

/** Risolve il dialetto di una connessione dall'elenco /connections. */
async function fetchDialect(
	ctx: IExecuteFunctions | ILoadOptionsFunctions,
	connection: string,
): Promise<Dialect> {
	const res = await gatewayRequest(ctx, 'GET', '/connections');
	const list = Array.isArray(res) ? (res as IDataObject[]) : [];
	const found = list.find((c) => c.name === connection);
	return ((found?.dialect as Dialect) ?? 'unknown') as Dialect;
}

/** Estrae messaggio/SQLSTATE da un errore del gateway (400 con { detail: { error, sqlstate } }). */
function gatewayErrorMessage(error: unknown): string | undefined {
	const anyErr = error as { response?: { body?: IDataObject }; cause?: { response?: { body?: IDataObject } } };
	const body = anyErr?.response?.body ?? anyErr?.cause?.response?.body;
	const detail = body?.detail as IDataObject | string | undefined;
	if (detail === undefined) return undefined;
	if (typeof detail === 'string') return detail;
	const sqlstate = detail.sqlstate ? ` [SQLSTATE ${detail.sqlstate}]` : '';
	return `${detail.error ?? 'Errore del driver'}${sqlstate}`;
}

/** SQLSTATE dell'errore del gateway, se presente (es. '23505'). */
function gatewaySqlState(error: unknown): string | undefined {
	const anyErr = error as { response?: { body?: IDataObject }; cause?: { response?: { body?: IDataObject } } };
	const body = anyErr?.response?.body ?? anyErr?.cause?.response?.body;
	const detail = body?.detail as IDataObject | undefined;
	const ss = detail?.sqlstate;
	return typeof ss === 'string' ? ss : undefined;
}

/** True se l'errore è una violazione di vincolo di integrità (SQLSTATE classe 23). */
function isUniqueViolation(error: unknown): boolean {
	return (gatewaySqlState(error) ?? '').startsWith('23');
}

export class OdbcGateway implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ODBC/JDBC Gateway',
		name: 'odbcGateway',
		icon: 'file:odbcGateway.svg',
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Esegue query SQL su RDBMS multipli tramite il gateway ODBC/JDBC',
		defaults: { name: 'ODBC/JDBC Gateway' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: 'odbcGatewayApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Table', value: 'table' },
					{ name: 'Query', value: 'query' },
					{ name: 'Connection', value: 'connection' },
					{ name: 'System', value: 'system' },
				],
				default: 'table',
			},
			// --- Operazioni: Table ---
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['table'] } },
				options: [
					{
						name: 'Select',
						value: 'select',
						action: 'Select rows from a table',
						description: 'Read rows, choosing columns, filter, sort and limit from the UI',
					},
					{
						name: 'Upsert',
						value: 'upsert',
						action: 'Insert or update rows',
						description: 'Insert a row, or update it when the match columns already exist',
					},
					{
						name: 'Delete',
						value: 'delete',
						action: 'Delete rows from a table',
						description: 'Delete the rows matching the conditions set in the UI',
					},
				],
				default: 'select',
			},
			// --- Campi comuni Table (connection / schema / table) ---
			{
				displayName: 'Connection Name or ID',
				name: 'tableConnection',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getConnections' },
				required: true,
				default: '',
				description:
					'The preconfigured gateway connection to use. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: { show: { resource: ['table'] } },
			},
			{
				displayName: 'Schema Name or ID',
				name: 'tableSchema',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getSchemas',
					loadOptionsDependsOn: ['tableConnection'],
				},
				default: '',
				description:
					'Schema that contains the table (e.g. "public", "dbo"). Leave empty to use the driver default. Choose from the list, or specify an ID using an expression.',
				displayOptions: { show: { resource: ['table'] } },
			},
			{
				displayName: 'Table Name or ID',
				name: 'tableName',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getTablesForSchema',
					loadOptionsDependsOn: ['tableConnection', 'tableSchema'],
				},
				required: true,
				default: '',
				description:
					'The table to operate on. Choose from the list, or specify a name using an expression.',
				displayOptions: { show: { resource: ['table'] } },
			},
			// --- Select ---
			{
				displayName: 'Output Columns',
				name: 'outputColumns',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getColumns',
					loadOptionsDependsOn: ['tableConnection', 'tableSchema', 'tableName'],
				},
				default: [],
				description:
					'Columns to return. Leave empty to return all columns (SELECT *). Choose from the list, or specify IDs using an expression.',
				displayOptions: { show: { resource: ['table'], operation: ['select'] } },
			},
			// --- Where (Select + Delete) ---
			{
				displayName: 'Conditions (WHERE)',
				name: 'whereConditions',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add condition',
				default: {},
				description:
					'Filter rows. Conditions are combined with the operator set in "Combine Conditions". Values are sent as bound query parameters, so they are safe from SQL injection.',
				displayOptions: { show: { resource: ['table'], operation: ['select', 'delete'] } },
				options: [
					{
						displayName: 'Condition',
						name: 'condition',
						values: [
							{
								displayName: 'Column Name or ID',
								name: 'column',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getColumns',
									loadOptionsDependsOn: ['tableConnection', 'tableSchema', 'tableName'],
								},
								default: '',
								description:
									'Column to filter on. Choose from the list, or specify an ID using an expression.',
							},
							{
								displayName: 'Operator',
								name: 'operator',
								type: 'options',
								default: '=',
								description:
									'Comparison operator. "Is Null"/"Is Not Null" ignore the value; "In" expects a comma-separated list.',
								options: [
									{ name: 'Equals', value: '=' },
									{ name: 'Not Equals', value: '!=' },
									{ name: 'Greater Than', value: '>' },
									{ name: 'Greater Or Equal', value: '>=' },
									{ name: 'Less Than', value: '<' },
									{ name: 'Less Or Equal', value: '<=' },
									{ name: 'Like', value: 'LIKE' },
									{ name: 'In', value: 'IN' },
									{ name: 'Is Null', value: 'IS NULL' },
									{ name: 'Is Not Null', value: 'IS NOT NULL' },
								],
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								description:
									'Value to compare against. For "Like" use % as wildcard; for "In" use a comma-separated list. Ignored for "Is Null"/"Is Not Null".',
								displayOptions: { hide: { operator: ['IS NULL', 'IS NOT NULL'] } },
							},
						],
					},
				],
			},
			{
				displayName: 'Combine Conditions',
				name: 'whereCombine',
				type: 'options',
				default: 'AND',
				description: 'How to join multiple WHERE conditions',
				options: [
					{ name: 'AND', value: 'AND' },
					{ name: 'OR', value: 'OR' },
				],
				displayOptions: { show: { resource: ['table'], operation: ['select', 'delete'] } },
			},
			// --- Sort + Limit (Select) ---
			{
				displayName: 'Sort',
				name: 'sort',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add sort rule',
				default: {},
				description: 'Order the result by one or more columns',
				displayOptions: { show: { resource: ['table'], operation: ['select'] } },
				options: [
					{
						displayName: 'Rule',
						name: 'rule',
						values: [
							{
								displayName: 'Column Name or ID',
								name: 'column',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getColumns',
									loadOptionsDependsOn: ['tableConnection', 'tableSchema', 'tableName'],
								},
								default: '',
								description:
									'Column to sort by. Choose from the list, or specify an ID using an expression.',
							},
							{
								displayName: 'Direction',
								name: 'direction',
								type: 'options',
								default: 'ASC',
								options: [
									{ name: 'Ascending', value: 'ASC' },
									{ name: 'Descending', value: 'DESC' },
								],
								description: 'Sort direction',
							},
						],
					},
				],
			},
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				default: false,
				description: 'Whether to return all matching rows, or only up to a given limit',
				displayOptions: { show: { resource: ['table'], operation: ['select'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 50,
				typeOptions: { minValue: 1 },
				description: 'Max number of rows to return',
				displayOptions: {
					show: { resource: ['table'], operation: ['select'], returnAll: [false] },
				},
			},
			// --- Delete safeguard ---
			{
				displayName: 'Delete All Rows',
				name: 'deleteAll',
				type: 'boolean',
				default: false,
				description:
					'Whether to allow deleting every row when no conditions are set. Safeguard against accidental full-table deletes.',
				displayOptions: { show: { resource: ['table'], operation: ['delete'] } },
			},
			// --- Upsert ---
			{
				displayName: 'Match Columns',
				name: 'matchColumns',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getColumns',
					loadOptionsDependsOn: ['tableConnection', 'tableSchema', 'tableName'],
				},
				required: true,
				default: [],
				description:
					'Key columns used to decide insert vs update: a row is updated when these match an existing row, otherwise inserted. Usually the primary key. Choose from the list, or specify IDs using an expression.',
				displayOptions: { show: { resource: ['table'], operation: ['upsert'] } },
			},
			{
				displayName: 'Values to Send',
				name: 'upsertValues',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add column',
				default: {},
				description:
					'Column/value pairs to insert or update. Include the match columns. Values are sent as bound query parameters.',
				displayOptions: { show: { resource: ['table'], operation: ['upsert'] } },
				options: [
					{
						displayName: 'Value',
						name: 'value',
						values: [
							{
								displayName: 'Column Name or ID',
								name: 'column',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getColumns',
									loadOptionsDependsOn: ['tableConnection', 'tableSchema', 'tableName'],
								},
								default: '',
								description:
									'Target column. Choose from the list, or specify an ID using an expression.',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								description:
									'Value to set. Use an expression to map data from the input item (e.g. {{ $json.name }}).',
							},
						],
					},
				],
			},
			// --- Operazioni: Query ---
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['query'] } },
				options: [
					{
						name: 'Execute Query',
						value: 'executeQuery',
						action: 'Esegue una SELECT e restituisce le righe',
						description: 'Esegue una SELECT (o simili) e restituisce i record',
					},
					{
						name: 'Execute Statement',
						value: 'executeStatement',
						action: 'Esegue INSERT UPDATE DELETE o DDL',
						description: 'Esegue uno statement di scrittura/DDL e restituisce le righe interessate',
					},
				],
				default: 'executeQuery',
			},
			// --- Operazioni: Connection ---
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['connection'] } },
				options: [
					{
						name: 'List',
						value: 'list',
						action: 'Elenca le connessioni configurate',
						description: 'Restituisce le connessioni preconfigurate nel gateway',
					},
					{
						name: 'List Tables',
						value: 'listTables',
						action: 'Elenca le tabelle di un DB',
						description: 'Elenca tabelle e viste del DB di una connessione (un item per tabella)',
					},
				],
				default: 'list',
			},
			// --- Parametri: Connection > List Tables ---
			{
				displayName: 'Connection Name or ID',
				name: 'tablesConnection',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getConnections' },
				required: true,
				default: '',
				description:
					'Connessione di cui elencare le tabelle. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: { show: { resource: ['connection'], operation: ['listTables'] } },
			},
			{
				displayName: 'Options',
				name: 'tablesOptions',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { resource: ['connection'], operation: ['listTables'] } },
				options: [
					{
						displayName: 'Schema',
						name: 'schema',
						type: 'string',
						default: '',
						description: 'Filtra per schema (es. dbo, public)',
					},
					{
						displayName: 'Catalog',
						name: 'catalog',
						type: 'string',
						default: '',
						description: 'Filtra per catalog/database',
					},
					{
						displayName: 'Types',
						name: 'types',
						type: 'string',
						default: 'TABLE,VIEW',
						description: "Tipi separati da virgola (es. TABLE,VIEW). Usa '*' per tutti",
					},
				],
			},
			// --- Operazioni: System ---
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['system'] } },
				options: [
					{
						name: 'Health',
						value: 'health',
						action: 'Check the gateway status',
						description: 'Check that the gateway responds',
					},
					{
						name: 'Get Logs',
						value: 'logs',
						action: 'Read the gateway call log',
						description: 'Read the structured call log (API + driver) with date filters — no server access needed',
					},
				],
				default: 'health',
			},
			// --- System > Get Logs ---
			{
				displayName: 'From',
				name: 'logFrom',
				type: 'dateTime',
				default: '',
				description: 'Start of the time range (UTC). Leave empty for no lower bound.',
				displayOptions: { show: { resource: ['system'], operation: ['logs'] } },
			},
			{
				displayName: 'To',
				name: 'logTo',
				type: 'dateTime',
				default: '',
				description: 'End of the time range (UTC). Leave empty for no upper bound.',
				displayOptions: { show: { resource: ['system'], operation: ['logs'] } },
			},
			{
				displayName: 'Filters',
				name: 'logFilters',
				type: 'collection',
				placeholder: 'Add filter',
				default: {},
				displayOptions: { show: { resource: ['system'], operation: ['logs'] } },
				options: [
					{
						displayName: 'Event',
						name: 'event',
						type: 'options',
						default: '',
						description: 'Type of log entry to return',
						options: [
							{ name: 'Any', value: '' },
							{ name: 'API Request', value: 'api_request' },
							{ name: 'API Response', value: 'api_response' },
							{ name: 'DB Execution', value: 'db_exec' },
						],
					},
					{
						displayName: 'Outcome',
						name: 'outcome',
						type: 'options',
						default: '',
						description: 'Filter DB executions by outcome',
						options: [
							{ name: 'Any', value: '' },
							{ name: 'Ok', value: 'ok' },
							{ name: 'Error', value: 'error' },
						],
					},
					{
						displayName: 'Connection',
						name: 'connection',
						type: 'string',
						default: '',
						description: 'Filter by connection name',
					},
					{
						displayName: 'Search',
						name: 'q',
						type: 'string',
						default: '',
						description: 'Return only lines containing this substring',
					},
					{
						displayName: 'Order',
						name: 'order',
						type: 'options',
						default: 'desc',
						description: 'Sort by timestamp',
						options: [
							{ name: 'Newest First', value: 'desc' },
							{ name: 'Oldest First', value: 'asc' },
						],
					},
				],
			},
			{
				displayName: 'Limit',
				name: 'logLimit',
				type: 'number',
				default: 200,
				typeOptions: { minValue: 1, maxValue: 5000 },
				description: 'Max number of log entries to return',
				displayOptions: { show: { resource: ['system'], operation: ['logs'] } },
			},
			// --- Parametri comuni alle Query ---
			{
				displayName: 'Connection Name or ID',
				name: 'connection',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getConnections' },
				required: true,
				default: '',
				description:
					'Connessione preconfigurata sul gateway. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: { show: { resource: ['query'] } },
			},
			{
				displayName: 'SQL',
				name: 'sql',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				placeholder: 'SELECT * FROM ...',
				displayOptions: { show: { resource: ['query'] } },
			},
			{
				displayName:
					"Tip: enable Preview and click <b>Test step</b> to see the first 100 rows in the output panel.",
				name: 'previewNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { resource: ['query'], operation: ['executeQuery'] } },
			},
			{
				displayName: 'Preview (Max 100 Rows)',
				name: 'previewMode',
				type: 'boolean',
				default: false,
				description:
					'Whether to cap the result to 100 rows for a quick preview. Run the node (Test step) to see the output table.',
				displayOptions: { show: { resource: ['query'], operation: ['executeQuery'] } },
			},
			{
				displayName: 'Split Rows Into Items',
				name: 'splitRows',
				type: 'boolean',
				default: true,
				description:
					'Whether to return one item per record with named columns instead of the raw gateway response',
				displayOptions: { show: { resource: ['query'], operation: ['executeQuery'] } },
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { resource: ['query'] } },
				options: [
					{
						displayName: 'Parameters',
						name: 'params',
						type: 'json',
						default: '[]',
						description: 'Array JSON di parametri posizionali per i placeholder ? nello statement',
					},
					{
						displayName: 'Max Rows',
						name: 'maxRows',
						type: 'number',
						default: 0,
						description: 'Numero massimo di righe da restituire (0 = default del gateway)',
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			async getConnections(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await gatewayRequest(this, 'GET', '/connections');
				const list = Array.isArray(data) ? (data as IDataObject[]) : [];
				return list.map((c) => ({
					name: `${c.name} (${c.driver}${c.read_only ? ', read-only' : ''})`,
					value: c.name as string,
				}));
			},

			async getSchemas(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const conn = this.getNodeParameter('tableConnection', '') as string;
				if (!conn) return [];
				const res = (await gatewayRequest(
					this,
					'GET',
					`/connections/${encodeURIComponent(conn)}/tables?types=*`,
				)) as IDataObject;
				const tables = (res.tables as IDataObject[]) ?? [];
				const schemas = Array.from(
					new Set(tables.map((t) => t.schema).filter((s): s is string => !!s)),
				).sort();
				return schemas.map((s) => ({ name: s, value: s }));
			},

			async getTablesForSchema(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const conn = this.getNodeParameter('tableConnection', '') as string;
				if (!conn) return [];
				const schema = this.getNodeParameter('tableSchema', '') as string;
				const qs = schema ? `?schema=${encodeURIComponent(schema)}` : '';
				const res = (await gatewayRequest(
					this,
					'GET',
					`/connections/${encodeURIComponent(conn)}/tables${qs}`,
				)) as IDataObject;
				const tables = (res.tables as IDataObject[]) ?? [];
				return tables
					.map((t) => t.name as string)
					.filter(Boolean)
					.sort()
					.map((n) => ({ name: n, value: n }));
			},

			async getColumns(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const conn = this.getNodeParameter('tableConnection', '') as string;
				const table = this.getNodeParameter('tableName', '') as string;
				if (!conn || !table) return [];
				const schema = this.getNodeParameter('tableSchema', '') as string;
				const cols = await fetchColumns(this, conn, schema, table);
				return cols.map((c) => ({
					name: `${c.name}${c.primary_key ? ' (PK)' : ''}`,
					value: c.name as string,
					description: (c.type as string) ?? undefined,
				}));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'table') {
					const connection = this.getNodeParameter('tableConnection', i) as string;
					const schema = this.getNodeParameter('tableSchema', i, '') as string;
					const table = this.getNodeParameter('tableName', i) as string;
					const dialect = await fetchDialect(this, connection);

					if (operation === 'select') {
						const columns = this.getNodeParameter('outputColumns', i, []) as string[];
						const where = this.getNodeParameter(
							'whereConditions.condition',
							i,
							[],
						) as WhereCondition[];
						const combine = this.getNodeParameter('whereCombine', i, 'AND') as string;
						const sort = this.getNodeParameter('sort.rule', i, []) as SortRule[];
						const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
						const built = buildSelect(dialect, { table, schema, columns, where, combine, sort });
						const body: IDataObject = {
							connection,
							sql: built.sql,
							params: built.params,
						};
						if (!returnAll) {
							body.max_rows = this.getNodeParameter('limit', i, 50) as number;
						}
						const res = (await gatewayRequest(this, 'POST', '/query', body)) as IDataObject;
						returnData.push(...rowsToItems(res, i));
						continue;
					}

					if (operation === 'delete') {
						const where = this.getNodeParameter(
							'whereConditions.condition',
							i,
							[],
						) as WhereCondition[];
						const combine = this.getNodeParameter('whereCombine', i, 'AND') as string;
						const deleteAll = this.getNodeParameter('deleteAll', i, false) as boolean;
						const built = buildDelete(dialect, { table, schema, where, combine });
						if (!built.sql.includes(' WHERE ') && !deleteAll) {
							throw new NodeOperationError(
								this.getNode(),
								'No conditions set. Enable "Delete All Rows" to delete every row in the table.',
								{ itemIndex: i },
							);
						}
						const res = (await gatewayRequest(this, 'POST', '/query', {
							connection,
							sql: built.sql,
							params: built.params,
						})) as IDataObject;
						returnData.push({
							json: { table, affected_rows: res.affected_rows ?? null },
							pairedItem: { item: i },
						});
						continue;
					}

					if (operation === 'upsert') {
						const matchColumns = this.getNodeParameter('matchColumns', i, []) as string[];
						const valuesRaw = this.getNodeParameter('upsertValues.value', i, []) as Array<{
							column: string;
							value: unknown;
						}>;
						if (!matchColumns.length) {
							throw new NodeOperationError(
								this.getNode(),
								'Select at least one Match Column for the upsert.',
								{ itemIndex: i },
							);
						}
						const valuePairs = valuesRaw.filter((v) => v.column);
						if (!valuePairs.length) {
							throw new NodeOperationError(
								this.getNode(),
								'Add at least one column in "Values to Send".',
								{ itemIndex: i },
							);
						}
						const columns = valuePairs.map((v) => v.column);
						const values = valuePairs.map((v) => v.value);
						for (const m of matchColumns) {
							if (!columns.includes(m)) {
								throw new NodeOperationError(
									this.getNode(),
									`Match column "${m}" must also be present in "Values to Send".`,
									{ itemIndex: i },
								);
							}
						}
						const matchValues = matchColumns.map((m) => values[columns.indexOf(m)]);
						const setColumns = columns.filter((c) => !matchColumns.includes(c));
						const setValues = setColumns.map((c) => values[columns.indexOf(c)]);

						// 1) La riga con questa chiave esiste già?
						const exists = buildExists(dialect, {
							table,
							schema,
							matchColumns,
							matchValues,
						});
						const existsRes = (await gatewayRequest(this, 'POST', '/query', {
							connection,
							sql: exists.sql,
							params: exists.params,
							max_rows: 1,
						})) as IDataObject;
						const rowExists = ((existsRes.row_count as number) ?? 0) > 0;

						const doUpdate = async (): Promise<IDataObject> => {
							const upd = buildUpdate(dialect, {
								table,
								schema,
								setColumns,
								setValues,
								matchColumns,
								matchValues,
							});
							return (await gatewayRequest(this, 'POST', '/query', {
								connection,
								sql: upd.sql,
								params: upd.params,
							})) as IDataObject;
						};

						let action: string;
						let writeRes: IDataObject;
						if (rowExists) {
							if (!setColumns.length) {
								// Solo colonne chiave: niente da aggiornare.
								action = 'skipped (no non-key columns to update)';
								writeRes = { affected_rows: 0 };
							} else {
								action = 'updated';
								writeRes = await doUpdate();
							}
						} else {
							const ins = buildInsert(dialect, { table, schema, columns, values });
							try {
								writeRes = (await gatewayRequest(this, 'POST', '/query', {
									connection,
									sql: ins.sql,
									params: ins.params,
								})) as IDataObject;
								action = 'inserted';
							} catch (insErr) {
								// Race SELECT→INSERT: la riga è comparsa nel frattempo → UPDATE.
								if (isUniqueViolation(insErr) && setColumns.length) {
									action = 'updated';
									writeRes = await doUpdate();
								} else {
									throw insErr;
								}
							}
						}

						returnData.push({
							json: {
								table,
								action,
								affected_rows: writeRes.affected_rows ?? null,
							},
							pairedItem: { item: i },
						});
						continue;
					}
				}

				if (resource === 'system' && operation === 'health') {
					const res = (await gatewayRequest(this, 'GET', '/health')) as IDataObject;
					returnData.push({ json: res, pairedItem: { item: i } });
					continue;
				}

				if (resource === 'system' && operation === 'logs') {
					const from = this.getNodeParameter('logFrom', i, '') as string;
					const to = this.getNodeParameter('logTo', i, '') as string;
					const limit = this.getNodeParameter('logLimit', i, 200) as number;
					const f = this.getNodeParameter('logFilters', i, {}) as IDataObject;
					const qs: string[] = [`limit=${encodeURIComponent(String(limit))}`];
					if (from) qs.push(`from=${encodeURIComponent(String(from))}`);
					if (to) qs.push(`to=${encodeURIComponent(String(to))}`);
					if (f.event) qs.push(`event=${encodeURIComponent(String(f.event))}`);
					if (f.outcome) qs.push(`outcome=${encodeURIComponent(String(f.outcome))}`);
					if (f.connection) qs.push(`connection=${encodeURIComponent(String(f.connection))}`);
					if (f.q) qs.push(`q=${encodeURIComponent(String(f.q))}`);
					if (f.order) qs.push(`order=${encodeURIComponent(String(f.order))}`);
					const res = (await gatewayRequest(this, 'GET', `/logs?${qs.join('&')}`)) as IDataObject;
					const logs = (res.logs as IDataObject[]) ?? [];
					for (const entry of logs) {
						returnData.push({ json: entry, pairedItem: { item: i } });
					}
					continue;
				}

				if (resource === 'connection' && operation === 'list') {
					const res = await gatewayRequest(this, 'GET', '/connections');
					const list = Array.isArray(res) ? (res as IDataObject[]) : [];
					for (const conn of list) {
						returnData.push({ json: conn, pairedItem: { item: i } });
					}
					continue;
				}

				if (resource === 'connection' && operation === 'listTables') {
					const conn = this.getNodeParameter('tablesConnection', i) as string;
					const opts = this.getNodeParameter('tablesOptions', i, {}) as IDataObject;
					const qs: string[] = [];
					if (opts.schema) qs.push(`schema=${encodeURIComponent(String(opts.schema))}`);
					if (opts.catalog) qs.push(`catalog=${encodeURIComponent(String(opts.catalog))}`);
					if (opts.types) qs.push(`types=${encodeURIComponent(String(opts.types))}`);
					const query = qs.length ? `?${qs.join('&')}` : '';
					const endpoint = `/connections/${encodeURIComponent(conn)}/tables${query}`;
					const res = (await gatewayRequest(this, 'GET', endpoint)) as IDataObject;
					const tables = (res.tables as IDataObject[]) ?? [];
					for (const t of tables) {
						returnData.push({ json: t, pairedItem: { item: i } });
					}
					continue;
				}

				if (resource === 'query') {
					const connection = this.getNodeParameter('connection', i) as string;
					const sql = this.getNodeParameter('sql', i) as string;
					const options = this.getNodeParameter('options', i, {}) as IDataObject;

					const body: IDataObject = { connection, sql };

					if (options.params !== undefined && options.params !== '') {
						let params = options.params;
						if (typeof params === 'string') {
							try {
								params = JSON.parse(params);
							} catch {
								throw new NodeOperationError(
									this.getNode(),
									'Parameters deve essere un array JSON valido',
									{ itemIndex: i },
								);
							}
						}
						body.params = params;
					}

					const previewMode =
						operation === 'executeQuery' &&
						(this.getNodeParameter('previewMode', i, false) as boolean);
					if (previewMode) {
						// Preview: cap a 100 righe, ignora Max Rows.
						body.max_rows = 100;
					} else if (options.maxRows !== undefined && Number(options.maxRows) > 0) {
						body.max_rows = Number(options.maxRows);
					}

					const res = (await gatewayRequest(this, 'POST', '/query', body)) as IDataObject;

					if (operation === 'executeStatement') {
						returnData.push({
							json: {
								connection: res.connection,
								affected_rows: res.affected_rows ?? null,
								elapsed_ms: res.elapsed_ms,
							},
							pairedItem: { item: i },
						});
						continue;
					}

					// executeQuery
					const splitRows = this.getNodeParameter('splitRows', i, true) as boolean;
					if (splitRows) {
						const mapped = rowsToItems(res, i);
						if (mapped.length === 0) {
							// Nessuna riga: restituiamo i metadati per non perdere l'item.
							returnData.push({
								json: {
									connection: res.connection,
									row_count: 0,
									columns: res.columns ?? [],
									affected_rows: res.affected_rows ?? null,
								},
								pairedItem: { item: i },
							});
						} else {
							returnData.push(...mapped);
						}
					} else {
						returnData.push({ json: res, pairedItem: { item: i } });
					}
					continue;
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				const message = gatewayErrorMessage(error);
				throw new NodeApiError(this.getNode(), error as JsonObject, {
					itemIndex: i,
					...(message ? { message } : {}),
				});
			}
		}

		return [returnData];
	}
}
