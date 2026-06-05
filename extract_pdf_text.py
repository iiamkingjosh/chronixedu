from pathlib import Path
from PyPDF2 import PdfReader

pdf_path = Path('ChronixEdu_AgentFile.pdf')
text_path = Path('ChronixEdu_AgentFile_extracted.txt')
reader = PdfReader(pdf_path)
with text_path.open('w', encoding='utf-8') as f:
    for i, page in enumerate(reader.pages, start=1):
        f.write(f'--- PAGE {i} ---\n')
        page_text = page.extract_text()
        f.write((page_text or '[NO TEXT]') + '\n')
print('WROTE', text_path)
