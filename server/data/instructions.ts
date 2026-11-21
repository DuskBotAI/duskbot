// No imports: harness-mcp-proxy bundles this file into the agent process.

export const DATA_INSTRUCTIONS =
  "The Data tools run DuckDB SQL on this bot's own database; results appear in this conversation. " +
  "Dialect: double quotes name identifiers (\"Order Date\"), single quotes make strings ('2024-01-01'); identifiers are case-insensitive. " +
  "GROUP BY ALL groups by every non-aggregated column; QUALIFY filters window results; SELECT * EXCLUDE (col) and COLUMNS('re.*') pick columns; PIVOT/UNPIVOT reshape. " +
  "Dates: date_trunc('month', d), time_bucket(INTERVAL '1 week', ts), strftime(d, '%Y-%m'), d::DATE, try_cast(x AS DOUBLE), today(), now(). " +
  "Strings and lists are 1-based (substr, list[1]); sum() of an empty group is NULL; -2^2 is 4; x IN (0, NULL) is NULL when no match. " +
  "Read files directly: read_csv('a.csv'), read_parquet('dir/*.parquet'), read_json_auto('x.ndjson'), read_xlsx('b.xlsx', sheet='S'); " +
  "SUMMARIZE tbl, DESCRIBE tbl and SHOW TABLES describe what is loaded. " +
  "Run data_describe before writing SQL against a table; aggregate or filter in SQL before charting; one statement per call. " +
  "To present your answer, call data_show: in this conversation a chart is drawn in full and a table shows as its title with its SQL, so state the rows or numbers that matter in your reply. " +
  "To discuss or edit a saved query, call data_describe with its id, or with no arguments for the latest saved result and the result/table catalog. Latest may not be the result the person means; use an id from the conversation or clarify when ambiguous. " +
  "Update that result with data_show id and sql; omitted kind and chart settings stay unchanged. Use these tools, not computer/UI automation, to read or change SQL. Never guess fields listed as omitted in a bounded result. " +
  "You can clean data with Python using your existing tools, save CSV/Parquet/JSON, then data_load and data_show; write no dashboard or chart JavaScript unless the person asks for a dashboard page.";

export const BUILT_IN_DATA_SYSTEM_PROMPT =
  " You have Data tools on your own DuckDB database (data_load, data_describe, data_sql, data_show, data_export): use them, not the computer, for tables, sums and charts. data_show draws a chart in full but shows a table only as its title, so state its key rows in your reply. To change a saved result, read it with data_describe and pass its id and new sql to data_show; the latest result is not always the one they mean. Look at an unfamiliar table before writing SQL, and aggregate before charting.";
