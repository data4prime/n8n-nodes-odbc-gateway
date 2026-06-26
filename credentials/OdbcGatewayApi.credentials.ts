import {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class OdbcGatewayApi implements ICredentialType {
	name = 'odbcGatewayApi';

	displayName = 'ODBC/JDBC Gateway API';

	documentationUrl = 'https://github.com/data4prime/n8n-nodes-odbc-gateway';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://host.docker.internal:8000',
			placeholder: 'http://host.docker.internal:8000',
			required: true,
			description:
				"URL del gateway. Da un n8n in Docker usa host.docker.internal invece di localhost.",
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: "Valore inviato nell'header X-API-Key",
		},
	];

	// Inietta automaticamente l'header X-API-Key in tutte le richieste.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-API-Key': '={{$credentials.apiKey}}',
			},
		},
	};

	// Pulsante "Test" in n8n: verifica le credenziali contro /health.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/health',
			method: 'GET',
		},
	};
}
