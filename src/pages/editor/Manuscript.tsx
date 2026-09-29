import { Icon } from "../../components/Icon";
import type { PreviewDocument } from "./previewData";

export function Manuscript({ document, visible }: { document: PreviewDocument; visible: boolean }) {
  return (
    <section
      className="editor-document"
      id={`editor-document-${document.id}`}
      hidden={!visible}
      aria-labelledby={`editor-document-title-${document.id}`}
    >
      <article className="manuscript" data-kind={document.kind}>
        <header className="manuscript-header">
          <p className="manuscript-context">{document.context}</p>
          <h1 className="manuscript-title" id={`editor-document-title-${document.id}`} tabIndex={-1}>{document.title}</h1>
        </header>
        <div className="manuscript-body">
          {document.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        </div>
      </article>
    </section>
  );
}

export function EmptyDocument() {
  return (
    <section className="editor-empty" aria-labelledby="editor-empty-title">
      <Icon name="book" size="brand" />
      <h1 id="editor-empty-title" tabIndex={-1}>从左侧打开一篇文稿</h1>
      <p>章节与创作资料将在这里显示。</p>
    </section>
  );
}

