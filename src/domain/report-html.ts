import type { Block, ReportModel } from "./report";

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char] ?? char));
}

function block(item: Block): string {
  if (item.type === "p") return `<p>${esc(item.text)}</p>`;
  if (item.type === "h3") return `<h3>${esc(item.text)}</h3>`;
  if (item.type === "note") return `<p class="note">${esc(item.text)}</p>`;
  if (item.type === "kv") return `<table>${item.rows.map((row) => `<tr><th>${esc(row.label)}</th><td>${esc(row.value)}</td></tr>`).join("")}</table>`;
  const head = item.headers.map((header) => `<th>${esc(header)}</th>`).join("");
  const rows = item.rows.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderReportHtml(model: ReportModel): string {
  const sections = model.sections.map((section) => `<section><h2>${esc(section.title)}</h2>${section.blocks.map(block).join("")}</section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>STWEG assessment report</title>
<style>
body{font-family:Helvetica,Arial,sans-serif;color:#1c1c1c;background:#fff;margin:2rem;line-height:1.45}
h1,h2{font-weight:600} table{border-collapse:collapse;width:100%;margin:0.6rem 0}
th,td{border:1px solid #e4e0d8;padding:0.35rem 0.45rem;text-align:left;vertical-align:top}
.note{border:1px solid #8a5a12;padding:0.5rem}
</style></head><body>
${model.blocked ? "<p class='note'>Preview only. Quality errors remain, so this extract is not a released report.</p>" : ""}
${sections}
</body></html>`;
}
