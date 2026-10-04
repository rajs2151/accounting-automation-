FROM python:3.12-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-ara \
    libgl1 libglib2.0-0 libgomp1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/pyproject.toml ./pyproject.toml
COPY worker/src ./src

# Install matching CPU torch+torchvision from the PyTorch index first (avoids nms skew),
# then the worker package (docTR / EasyOCR / pdfplumber).
RUN pip install --no-cache-dir --upgrade pip \
  && pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu \
  && pip install --no-cache-dir .

ENV DOCTR_DET_ARCH=db_resnet50 \
    DOCTR_RECO_ARCH=crnn_vgg16_bn \
    EASYOCR_LANGS=en,ar

# Warm weights into the image; fail the build if OCR stacks cannot import.
RUN python -c "import doctr, easyocr, torch, torchvision; print('doctr', doctr.__version__ if hasattr(doctr,'__version__') else 'ok'); print('easyocr ok'); print('torch', torch.__version__); print('torchvision', torchvision.__version__)" \
  && python -c "from daftar.ocr_engine import loaded_model_report; import json; r=loaded_model_report(); print(json.dumps(r, indent=2)); assert r['doctr_installed'] and r['easyocr_installed'], r; assert r['models_loaded'], r"

EXPOSE 4711
CMD ["python", "-m", "daftar.worker"]
