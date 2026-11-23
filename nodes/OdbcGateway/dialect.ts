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
	// Se valorizzato, ordina per questo alias (di un aggregato) invece che per colonna.
	alias?: string;
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

// Mappa i token dell'operatore (valori della dropdown + simboli SQL legacy/interni) al SQL.
// I valori della dropdown NON devono iniziare con '=', altrimenti n8n li interpreta come
// un'espressione e svuota il campo: per questo usiamo token simbolici (eq, ne, ...).
const OPERATOR_SQL: Record<string, string> = {
	eq: '=',
	ne: '!=',
	gt: '>',
	ge: '>=',
	lt: '<',
	le: '<=',
	like: 'LIKE',
	in: 'IN',
	isnull: 'IS NULL',
	isnotnull: 'IS NOT NULL',
	// simboli SQL grezzi (retrocompatibilità + chiamanti interni: buildExists/buildUpdate)
	'=': '=',
	'!=': '!=',
	'<>': '!=',
	'>': '>',
	'>=': '>=',
	'<': '<',
	'<=': '<=',
	'is null': 'IS NULL',
	'is not null': 'IS NOT NULL',
};

function sqlOperator(raw: unknown): string {
	return OPERATOR_SQL[String(raw ?? 'eq').toLowerCase()] ?? '=';
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
		const op = sqlOperator(c.operator);
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

// Espressione aggregata per la Select assistita. La funzione proviene da una
// allowlist (mai interpolata grezza), colonna e alias sono quotati come identificatori.
export interface AggExpr {
	func: string;
	column?: string;
	countStar?: boolean;
	alias?: string;
}

// Funzioni di aggregazione ammesse: il token della UI viene mappato al nome SQL.
// countDistinct → COUNT(DISTINCT ...).
const AGG_FUNC: Record<string, { sql: string; distinct?: boolean }> = {
	count: { sql: 'COUNT' },
	countdistinct: { sql: 'COUNT', distinct: true },
	sum: { sql: 'SUM' },
	avg: { sql: 'AVG' },
	min: { sql: 'MIN' },
	max: { sql: 'MAX' },
};

// Costruisce una singola espressione aggregata; ritorna null se la funzione non è
// nell'allowlist o manca la colonna richiesta (verrà semplicemente ignorata).
export function buildAggExpr(dialect: Dialect, a: AggExpr): string | null {
	const key = String(a.func ?? '').toLowerCase();
	const aliased = (base: string): string =>
		a.alias ? `${base} AS ${quoteIdent(dialect, a.alias)}` : base;
	if (a.countStar && (key === 'count' || key === '')) {
		return aliased('COUNT(*)');
	}
	const fn = AGG_FUNC[key];
	if (!fn) return null;
	if (!a.column) return null;
	const col = quoteIdent(dialect, a.column);
	const inner = fn.distinct ? `DISTINCT ${col}` : col;
	return aliased(`${fn.sql}(${inner})`);
}

export interface SelectOptions {
	table: string;
	schema?: string;
	catalog?: string;
	columns?: string[];
	aggregations?: AggExpr[];
	groupBy?: string[];
	where?: WhereCondition[];
	combine?: string;
	sort?: SortRule[];
}

export function buildSelect(dialect: Dialect, o: SelectOptions): BuiltSql {
	const selectParts: string[] = [];
	if (o.columns && o.columns.length) {
		selectParts.push(...o.columns.map((c) => quoteIdent(dialect, c)));
	}
	if (o.aggregations && o.aggregations.length) {
		for (const a of o.aggregations) {
			const expr = buildAggExpr(dialect, a);
			if (expr) selectParts.push(expr);
		}
	}
	const cols = selectParts.length ? selectParts.join(', ') : '*';
	let sql = `SELECT ${cols} FROM ${qualify(dialect, o.table, o.schema, o.catalog)}`;
	const params: unknown[] = [];
	const w = buildWhere(dialect, o.where || [], o.combine || 'AND');
	if (w.sql) {
		sql += ` WHERE ${w.sql}`;
		params.push(...w.params);
	}
	if (o.groupBy && o.groupBy.length) {
		const g = o.groupBy
			.filter((c) => c)
			.map((c) => quoteIdent(dialect, c))
			.join(', ');
		if (g) sql += ` GROUP BY ${g}`;
	}
	if (o.sort && o.sort.length) {
		const order = o.sort
			.filter((s) => s.column || s.alias)
			.map((s) => {
				const target = s.alias
					? quoteIdent(dialect, s.alias)
					: quoteIdent(dialect, s.column);
				const dir = String(s.direction).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
				return `${target} ${dir}`;
			})
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

// --- Upsert PORTABILE: SELECT sulla chiave, poi INSERT o UPDATE ---
// Usa solo SELECT/INSERT/UPDATE → funziona su qualsiasi dialetto (niente MERGE/ON CONFLICT).
// Nota: non è atomico (SELECT e write sono statement separati); le match columns
// dovrebbero corrispondere a una chiave unica per una semantica corretta. La race
// SELECT→INSERT è gestita dal nodo con fallback a UPDATE sull'errore di vincolo (SQLSTATE 23xxx).

export interface KeyMatch {
	table: string;
	schema?: string;
	catalog?: string;
	matchColumns: string[];
	matchValues: unknown[];
}

/** SELECT per verificare se esiste già una riga con la chiave indicata. */
export function buildExists(dialect: Dialect, o: KeyMatch): BuiltSql {
	const where: WhereCondition[] = o.matchColumns.map((c, i) => ({
		column: c,
		operator: '=',
		value: o.matchValues[i],
	}));
	const w = buildWhere(dialect, where, 'AND');
	const firstCol = o.matchColumns.length ? quoteIdent(dialect, o.matchColumns[0]) : '*';
	let sql = `SELECT ${firstCol} FROM ${qualify(dialect, o.table, o.schema, o.catalog)}`;
	const params: unknown[] = [];
	if (w.sql) {
		sql += ` WHERE ${w.sql}`;
		params.push(...w.params);
	}
	return { sql, params };
}

export interface InsertOptions {
	table: string;
	schema?: string;
	catalog?: string;
	columns: string[];
	values: unknown[];
}

export function buildInsert(dialect: Dialect, o: InsertOptions): BuiltSql {
	const qc = o.columns.map((c) => quoteIdent(dialect, c)).join(', ');
	const placeholders = o.columns.map(() => '?').join(', ');
	return {
		sql: `INSERT INTO ${qualify(dialect, o.table, o.schema, o.catalog)} (${qc}) VALUES (${placeholders})`,
		params: o.values.map(coerce),
	};
}

export interface UpdateOptions {
	table: string;
	schema?: string;
	catalog?: string;
	setColumns: string[];
	setValues: unknown[];
	matchColumns: string[];
	matchValues: unknown[];
}

export function buildUpdate(dialect: Dialect, o: UpdateOptions): BuiltSql {
	const set = o.setColumns.map((c) => `${quoteIdent(dialect, c)} = ?`).join(', ');
	const where: WhereCondition[] = o.matchColumns.map((c, i) => ({
		column: c,
		operator: '=',
		value: o.matchValues[i],
	}));
	const w = buildWhere(dialect, where, 'AND');
	let sql = `UPDATE ${qualify(dialect, o.table, o.schema, o.catalog)} SET ${set}`;
	const params: unknown[] = o.setValues.map(coerce);
	if (w.sql) {
		sql += ` WHERE ${w.sql}`;
		params.push(...w.params);
	}
	return { sql, params };
}
