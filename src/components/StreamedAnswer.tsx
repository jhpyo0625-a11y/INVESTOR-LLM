// src/components/StreamedAnswer.tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function StreamedAnswer({ text }: { text: string }) {
  return (
    <article className="markdown-answer text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </article>
  );
}
