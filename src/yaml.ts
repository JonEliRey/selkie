// A fail-closed reader for the YAML subset this repo writes: nested mappings,
// sequences, plain and quoted scalars, `|` block literals, `#` comments.
// Anything outside that subset (anchors, aliases, tags, flow collections,
// folded scalars, multiple documents, tab indentation, duplicate keys) throws.
// Corp has no package install, and the DSL and the register must still parse.

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`yaml: line ${line}: ${message}`);
    this.name = "YamlError";
    this.line = line;
  }
}

type Line = { no: number; indent: number; text: string; raw: string };

export function parseYaml(text: string): YamlValue {
  const lines = split(text);
  const p = new Parser(lines);
  const first = p.next(0);
  if (first === undefined) return null;
  const { value, at } = p.block(first, lines[first]!.indent);
  const rest = p.next(at);
  if (rest !== undefined) throw new YamlError("content after the top-level block", lines[rest]!.no);
  return value;
}

function split(text: string): Line[] {
  return text.split("\n").map((rawLine, i) => {
    const raw = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const no = i + 1;
    let indent = 0;
    while (indent < raw.length && raw[indent] === " ") indent++;
    if (raw[indent] === "\t") throw new YamlError("tab indentation", no);
    const text = raw.slice(indent).trimEnd();
    if (indent === 0 && (text === "---" || text === "...")) throw new YamlError("only one document per file", no);
    return { no, indent, text, raw };
  });
}

class Parser {
  private readonly lines: Line[];
  constructor(lines: Line[]) {
    this.lines = lines;
  }

  /** Index of the next structural line at or after i (skips blank and comment lines). */
  next(i: number): number | undefined {
    for (let k = i; k < this.lines.length; k++) {
      const t = this.lines[k]!.text;
      if (t !== "" && !t.startsWith("#")) return k;
    }
    return undefined;
  }

  block(i: number, indent: number): { value: YamlValue; at: number } {
    const line = this.lines[i]!;
    if (line.indent !== indent) throw new YamlError("unexpected indentation", line.no);
    return isSeqItem(line.text) ? this.sequence(i, indent) : this.mapping(i, indent);
  }

  mapping(start: number, indent: number): { value: YamlValue; at: number } {
    const obj: { [key: string]: YamlValue } = {};
    let i: number | undefined = start;
    while (i !== undefined) {
      const line = this.lines[i]!;
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError("unexpected indentation", line.no);
      if (isSeqItem(line.text)) break;
      const { key, rest } = splitKey(line);
      if (Object.hasOwn(obj, key)) throw new YamlError(`duplicate key "${key}"`, line.no);
      const { value, at } = this.valueAfterKey(i, indent, rest);
      // defineProperty so a key named __proto__ is an own key, not a prototype swap.
      Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
      i = this.next(at);
    }
    return { value: obj, at: i ?? this.lines.length };
  }

  sequence(start: number, indent: number): { value: YamlValue; at: number } {
    const arr: YamlValue[] = [];
    let i: number | undefined = start;
    while (i !== undefined) {
      const line = this.lines[i]!;
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError("unexpected indentation", line.no);
      if (!isSeqItem(line.text)) break;
      const rest = line.text === "-" ? "" : line.text.slice(2).trim();
      if (rest === "" || rest.startsWith("#")) {
        const n = this.next(i + 1);
        if (n === undefined || this.lines[n]!.indent <= indent) {
          arr.push(null);
          i = n;
          continue;
        }
        const nested = this.block(n, this.lines[n]!.indent);
        arr.push(nested.value);
        i = this.next(nested.at);
      } else if (isSeqItem(rest) || looksLikeKey(rest)) {
        // The item body starts on the dash line; treat it as a block whose indent is the body's column.
        const inner = indent + line.text.length - rest.length;
        this.lines[i] = { ...line, indent: inner, text: rest };
        const nested = this.block(i, inner);
        arr.push(nested.value);
        i = this.next(nested.at);
      } else {
        arr.push(scalar(rest, line.no));
        i = this.next(i + 1);
      }
    }
    return { value: arr, at: i ?? this.lines.length };
  }

  valueAfterKey(i: number, indent: number, rest: string): { value: YamlValue; at: number } {
    const line = this.lines[i]!;
    if (rest === "" || rest.startsWith("#")) {
      const n = this.next(i + 1);
      if (n === undefined) return { value: null, at: i + 1 };
      const nl = this.lines[n]!;
      if (nl.indent > indent) return this.block(n, nl.indent);
      if (nl.indent === indent && isSeqItem(nl.text)) return this.sequence(n, indent);
      return { value: null, at: i + 1 };
    }
    if (rest === "|" || rest === "|-") return this.literal(i, indent, rest === "|-");
    if (rest.startsWith("|") || rest.startsWith(">")) throw new YamlError("only `|` block literals are supported", line.no);
    return { value: scalar(rest, line.no), at: i + 1 };
  }

  literal(i: number, indent: number, strip: boolean): { value: YamlValue; at: number } {
    const body: string[] = [];
    let k = i + 1;
    let blockIndent: number | undefined;
    for (; k < this.lines.length; k++) {
      const l = this.lines[k]!;
      if (l.raw.trim() === "") {
        body.push("");
        continue;
      }
      if (l.indent <= indent) break;
      if (blockIndent === undefined) blockIndent = l.indent;
      if (l.indent < blockIndent) throw new YamlError("block literal line under-indented", l.no);
      body.push(l.raw.slice(blockIndent));
    }
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    const value = body.join("\n") + (strip || body.length === 0 ? "" : "\n");
    return { value, at: k };
  }
}

/** True for a YAML mapping (a plain object): the shape every loader checks before reading keys. */
export function isMapping(v: YamlValue | undefined): v is { [key: string]: YamlValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSeqItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

function looksLikeKey(text: string): boolean {
  if (text.startsWith('"') || text.startsWith("'")) return false;
  return /^[^#\s&*!\[\]{}][^:#]*:(\s|$)/.test(text);
}

function splitKey(line: Line): { key: string; rest: string } {
  // A key may not open with an anchor, alias, tag, or flow marker: those are constructs the subset refuses.
  const m = /^([^\s"'#&*!\[\]{}][^:#]*?)\s*:(?:\s+(.*))?$/.exec(line.text);
  if (!m) throw new YamlError("expected `key: value`", line.no);
  return { key: m[1]!, rest: (m[2] ?? "").trim() };
}

function scalar(text: string, no: number): YamlValue {
  const c = text[0]!;
  if (c === "-" && (text === "-" || text[1] === " ")) throw new YamlError("a sequence must start on its own line", no);
  if (c === "&" || c === "*") throw new YamlError("anchors and aliases are not supported", no);
  if (c === "!") throw new YamlError("tags are not supported", no);
  if (c === "[" || c === "{") {
    const plain = stripComment(text);
    if (plain === "[]") return [];
    if (plain === "{}") return {};
    throw new YamlError("flow collections are not supported (only empty `[]` and `{}`)", no);
  }
  if (c === '"') return doubleQuoted(text, no);
  if (c === "'") return singleQuoted(text, no);
  const plain = stripComment(text);
  if (plain === "true") return true;
  if (plain === "false") return false;
  if (plain === "null" || plain === "~") return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(plain)) return Number(plain);
  return plain;
}

function stripComment(text: string): string {
  const at = text.search(/\s#/);
  return (at === -1 ? text : text.slice(0, at)).trimEnd();
}

function doubleQuoted(text: string, no: number): string {
  let out = "";
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") {
      const e = text[++i];
      if (e === "n") out += "\n";
      else if (e === "t") out += "\t";
      else if (e === '"' || e === "\\") out += e;
      else throw new YamlError(`unsupported escape \\${e ?? ""}`, no);
    } else if (ch === '"') {
      trailing(text.slice(i + 1), no);
      return out;
    } else out += ch;
  }
  throw new YamlError("unterminated double-quoted string", no);
}

function singleQuoted(text: string, no: number): string {
  let out = "";
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i++;
      } else {
        trailing(text.slice(i + 1), no);
        return out;
      }
    } else out += ch;
  }
  throw new YamlError("unterminated single-quoted string", no);
}

function trailing(rest: string, no: number): void {
  const t = rest.trim();
  if (t !== "" && !t.startsWith("#")) throw new YamlError("text after closing quote", no);
}
