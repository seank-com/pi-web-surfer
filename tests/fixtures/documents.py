"""Synthetic local documents. No downloaded assets or provider data."""
import io
import pathlib
import sys
import zipfile

root = pathlib.Path(sys.argv[1])
text = "PDFSOURCE-MUST-STAY-OUTSIDE-CONTEXT " * 2500 + "PDF-END-COMPLETE"
stream = ("BT /F1 10 Tf 36 720 Td (" + text + ") Tj ET").encode("ascii")
objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
           b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
           b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
           b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
pdf = bytearray(b"%PDF-1.4\n")
offsets = [0]
for i, item in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf += str(i).encode() + b" 0 obj\n" + item + b"\nendobj\n"
xref = len(pdf)
pdf += b"xref\n0 6\n0000000000 65535 f \n"
for offset in offsets[1:]:
    pdf += f"{offset:010d} 00000 n \n".encode()
pdf += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
(root / "report.pdf").write_bytes(pdf)
html = b"<html><h1>HTML fixture</h1><p>Document source remains complete.</p><table><tr><th>A</th><th>B</th></tr><tr><td>one</td><td>two</td></tr></table></html>"
(root / "page.html").write_bytes(html)
docx = io.BytesIO()
with zipfile.ZipFile(docx, "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    archive.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX fixture source complete.</w:t></w:r></w:p></w:body></w:document>')
(root / "report.docx").write_bytes(docx.getvalue())
with zipfile.ZipFile(root / "bundle.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("first.html", html)
    archive.writestr("../do-not-extract.txt", "NO-FILESYSTEM-EXTRACTION")
    archive.writestr("large.txt", "LARGE-SOURCE " * 180000 + "LARGE-END-COMPLETE")
    archive.writestr("duplicate.txt", "FIRST DUPLICATE")
    archive.writestr("duplicate.txt", "SECOND DUPLICATE")
