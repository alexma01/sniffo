import { ReactNode, TextareaHTMLAttributes, useRef } from "react";

// ponytail: regex tokenizer, JSON only; above LIMIT text stays plain so huge bodies render fast.
const LIMIT = 200_000;
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;

/** JSON (or JSON-like) text as spans coloured with the --syn-* theme tokens. */
export function highlightJson(text: string): ReactNode[] {
  if (text.length > LIMIT) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index!;
    if (i > last) out.push(text.slice(last, i));
    const k = out.length;
    if (m[1]) {
      out.push(<span key={k} className={m[2] ? "j-key" : "j-str"}>{m[1]}</span>);
      if (m[2]) out.push(<span key={k + 1} className="j-punct">{m[2]}</span>);
    } else if (m[3]) out.push(<span key={k} className="j-num">{m[3]}</span>);
    else if (m[4]) out.push(<span key={k} className={m[4] === "null" ? "j-null" : "j-bool"}>{m[4]}</span>);
    else out.push(<span key={k} className="j-punct">{m[5]}</span>);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const looksJson = (s: string) => /^\s*[{[]/.test(s);

/** Raw HTTP message: start line, "name: value" headers, then the body (coloured when it is JSON). */
export function highlightHttp(text: string): ReactNode[] {
  const split = text.indexOf("\n\n");
  const head = split < 0 ? text : text.slice(0, split);
  const body = split < 0 ? "" : text.slice(split + 2);
  const [start, ...headers] = head.split("\n");
  return [
    <span key="s" className="j-num">{start}</span>,
    ...headers.map((h, i) => {
      const c = h.indexOf(":");
      return <span key={i}>{"\n"}<span className="j-key">{h.slice(0, c)}</span><span className="j-punct">:</span>{h.slice(c + 1)}</span>;
    }),
    split < 0 ? null : "\n\n",
    ...(looksJson(body) ? highlightJson(body) : [body]),
  ];
}

/** A WebSocket frame or any one-line payload: coloured only when it is JSON. */
export const highlightMaybeJson = (text: string): ReactNode => (looksJson(text) ? highlightJson(text) : text);

/** "name: value" lines (header editors). */
export const highlightHeaders = (text: string): ReactNode[] =>
  text.split("\n").map((h, i) => {
    const c = h.indexOf(":");
    return <span key={i}>{i > 0 && "\n"}{c < 0 ? h : <><span className="j-key">{h.slice(0, c)}</span><span className="j-punct">:</span>{h.slice(c + 1)}</>}</span>;
  });

/** A textarea whose text is coloured: a transparent textarea over a highlighted <pre>, scrolled together. */
export function CodeArea({ value, kind, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string; kind: "json" | "headers" }) {
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className="code-area">
      <pre ref={pre} aria-hidden="true">{kind === "headers" ? highlightHeaders(value) : highlightMaybeJson(value)}{"\n"}</pre>
      <textarea {...rest} value={value} spellCheck={false}
        onScroll={(e) => { pre.current!.scrollTop = e.currentTarget.scrollTop; pre.current!.scrollLeft = e.currentTarget.scrollLeft; }} />
    </div>
  );
}
