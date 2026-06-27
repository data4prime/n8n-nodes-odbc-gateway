// Costruzione SQL per le operazioni guidate (Select/Delete/Upsert), per dialetto.
// Gli identificatori provengono dai metadati (dropdown) e vengono quotati;
// i valori sono SEMPRE parametrizzati con ? (binding lato driver).

export type Dialect = 'postgres' | 'mysql' | 'sqlserver' | 'oracle' | 'db2i' | 'unknown';

export interface WhereCondition {
	column: string;
	operator: string;
	value?: unknown;
}

export interface SortRule {
	column: string;
	direction?: string;
}

export interface BuiltSql {
	sql: string;
	params: unknown[];
}

export function quoteIdent(dialect: Dialect, name: string): string {
	const n = String(name);
	if (dialect === 'mysql') return '`' + n.replace(/`/g, '``') + '`';
	if (dialect === 'sqlserver') return '[' + n.replace(/]/g, ']]') + ']';
	// postgres, oracle, db2i, unknown → virgolette doppie standard SQL
	return '"' + n.replace(/"/g, '""') + '"';
}

export function qualify(dialect: Dialect, table: string, schema?: string, catalog?: string): string {
	const parts: string[] = [];
	if (catalog) parts.push(quoteIdent(dialect, catalog));
	if (schema) parts.push(quoteIdent(dialect, schema));
	parts.push(quoteIdent(dialect, table));
	return parts.join('.');
}

// Converte valori numerici scritti come stringa in number (binding più affidabile).
function coerce(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const t = value.trim();
	if (t === '') return value;
	if (/^-?\d+$/.test(t)) return parseInt(t, 10);
	if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
	return value;
}

export function buildWhere(
	dialect: Dialect,
	conditions: WhereCondition[],
	combine: string,
): BuiltSql {
	const parts: string[] = [];
	const params: unknown[] = [];
	for (const c of conditions) {
		if (!c.column) continue;
		const col = quoteIdent(dialect, c.column);
		const op = (c.operator || '=').toUpperCase();
		if (op === 'IS NULL') {
			parts.push(`${col} IS NULL`);
			continue;
		}
		if (op === 'IS NOT NULL') {
			parts.push(`${col} IS NOT NULL`);
			continue;
		}
		if (op === 'IN') {
			const vals = String(c.value ?? '')
				.split(',')
				.map((v) => v.trim())
				.filter((v) => v !== '')
				.map((v) => coerce(v));
			if (vals.length === 0) continue;
			parts.push(`${col} IN (${vals.map(() => '?').join(', ')})`);
			params.push(...vals);
			continue;
		}
		const sqlOp = ['=', '!=', '>', '>=', '<', '<=', 'LIKE'].includes(op) ? op : '=';
		parts.push(`${col} ${sqlOp} ?`);
		params.push(coerce(c.value));
	}
	const joiner = combine === 'OR' ? ' OR ' : ' AND ';
	return { sql: parts.join(joiner), params };
}

export interface SelectOptions {
	table: string;
	schema?: string;
	catalog?: string;
	columns?: string[];
	where?: WhereCondition[];
	combine?: string;
	sort?: SortRule[];
}

export function buildSelect(dialect: Dialect, o: SelectOptions): BuiltSql {
	const cols =
		o.columns && o.columns.length
			? o.columns.map((c) => quoteIdent(dialect, c)).join(', ')
			: '*';
	let sql = `SELECT ${cols} FROM ${qualify(dialect, o.table, o.schema, o.catalog)}`;
	const params: unknown[] = [];
	const w = buildWhere(dialect, o.where || [], o.combine || 'AND');
	if (w.sql) {
		sql += ` WHERE ${w.sql}`;
		params.push(...w.params);
	}
	if (o.sort && o.sort.length) {
		const order = o.sort
			.filter((s) => s.column)
			.map(
				(s) =>
					`${quoteIdent(dialect, s.column)} ${
						String(s.direction).toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
					}`,
			)
			.join(', ');
		if (order) sql += ` ORDER BY ${order}`;
	}
	return { sql, params };
}

export interface DeleteOptions {
	table: string;
	schema?: string;
	catalog?: string;
	where?: WhereCondition[];
	combine?: string;
}

export function buildDelete(dialect: Dialect, o: DeleteOptions): BuiltSql {
	let sql = `DELETE FROM ${qualify(dialect, o.table, o.schema, o.catalog)}`;
	const params: unknown[] = [];
	const w = buildWhere(dialect, o.where || [], o.combine || 'AND');
	if (w.sql) {
		sql += ` WHERE ${w.sql}`;
		params.push(...w.params);
	}
	return { sql, params };
}

export interface UpsertOptions {
	table: string;
	schema?: string;
	catalog?: string;
	columns: string[]; // nomi colonna, nell'ordine dei valori
	values: unknown[]; // valori (stesso ordine)
	matchColumns: string[]; // colonne chiave per il match
}

export function buildUpsert(dialect: Dialect, o: UpsertOptions): BuiltSql {
	const table = qualify(dialect, o.table, o.schema, o.catalog);
	const cols = o.columns;
	const match = o.matchColumns;
	const qc = cols.map((c) => quoteIdent(dialect, c));
	const placeholders = cols.map(() => '?').join(', ');
	const updateCols = cols.filter((c) => !match.includes(c));
	const params: unknown[] = [...o.values];

	if (dialect === 'mysql') {
		const upd = (updateCols.length ? updateCols : cols)
			.map((c) => `${quoteIdent(dialect, c)}=VALUES(${quoteIdent(dialect, c)})`)
			.join(', ');
		return {
			sql: `INSERT INTO ${table} (${qc.join(', ')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${upd}`,
			params,
		};
	}

	if (dialect === 'postgres' || dialect === 'unknown') {
		const conflict = match.map((c) => quoteIdent(dialect, c)).join(', ');
		const action = updateCols.length
			? `DO UPDATE SET ${updateCols
					.map((c) => `${quoteIdent(dialect, c)}=EXCLUDED.${quoteIdent(dialect, c)}`)
					.join(', ')}`
			: 'DO NOTHING';
		return {
			sql: `INSERT INTO ${table} (${qc.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${conflict}) ${action}`,
			params,
		};
	}

	// MERGE — sqlserver / oracle / db2i
	const onClause = match
		.map((c) => `T.${quoteIdent(dialect, c)} = S.${quoteIdent(dialect, c)}`)
		.join(' AND ');
	const insCols = qc.join(', ');
	const insVals = cols.map((c) => `S.${quoteIdent(dialect, c)}`).join(', ');
	const setClause = (updateCols.length ? updateCols : cols)
		.map((c) => `T.${quoteIdent(dialect, c)} = S.${quoteIdent(dialect, c)}`)
		.join(', ');

	if (dialect === 'oracle') {
		const using = `(SELECT ${cols
			.map((c) => `? AS ${quoteIdent(dialect, c)}`)
			.join(', ')} FROM dual)`;
		return {
			sql: `MERGE INTO ${table} T USING ${using} S ON (${onClause}) WHEN MATCHED THEN UPDATE SET ${setClause} WHEN NOT MATCHED THEN INSERT (${insCols}) VALUES (${insVals})`,
			params,
		};
	}

	if (dialect === 'db2i') {
		const using = `(VALUES (${placeholders})) AS S (${qc.join(', ')})`;
		return {
			sql: `MERGE INTO ${table} AS T USING ${using} ON ${onClause} WHEN MATCHED THEN UPDATE SET ${setClause} WHEN NOT MATCHED THEN INSERT (${insCols}) VALUES (${insVals})`,
			params,
		};
	}

	// sqlserver
	const using = `(SELECT ${cols.map((c) => `? AS ${quoteIdent(dialect, c)}`).join(', ')})`;
	return {
		sql: `MERGE INTO ${table} AS T USING ${using} AS S ON ${onClause} WHEN MATCHED THEN UPDATE SET ${setClause} WHEN NOT MATCHED THEN INSERT (${insCols}) VALUES (${insVals});`,
		params,
	};
}
