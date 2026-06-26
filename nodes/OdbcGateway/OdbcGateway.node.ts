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
					{ name: 'Query', value: 'query' },
					{ name: 'Connection', value: 'connection' },
					{ name: 'System', value: 'system' },
				],
				default: 'query',
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
				],
				default: 'list',
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
						action: 'Verifica lo stato del gateway',
						description: 'Controlla che il gateway risponda',
					},
				],
				default: 'health',
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
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				if (resource === 'system' && operation === 'health') {
					const res = (await gatewayRequest(this, 'GET', '/health')) as IDataObject;
					returnData.push({ json: res, pairedItem: { item: i } });
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

					if (options.maxRows !== undefined && Number(options.maxRows) > 0) {
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
