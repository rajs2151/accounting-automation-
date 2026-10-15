# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-ara \
    libgl1 libglib2.0-0 libgomp1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Layer order is deliberate: slow, rarely-changing steps first so a code change only rebuilds the last layers.
# 1) Dependencies, from pyproject.toml only (no source yet). CPU torch+torchvision from the PyTorch index first
#    (avoids nms skew and GBs of CUDA wheels), then the rest. The pip cache mount keeps wheels across rebuilds.
COPY worker/pyproject.toml ./pyproject.toml
RUN --mount=type=cache,target=/root/.cache/pip \
  pip install --upgrade pip \
  && pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu \
  && python -c "import tomllib; d=tomllib.load(open('pyproject.toml','rb'))['project']['dependencies']; open('/tmp/requirements.txt','w').write('\n'.join(d))" \
  && pip install -r /tmp/requirements.txt

ENV DOCTR_DET_ARCH=db_resnet50 \
    DOCTR_RECO_ARCH=crnn_vgg16_bn \
    EASYOCR_LANGS=en,ar

# 2) Download OCR model weights into the image (depends only on the libraries above, not on our code).
RUN python -c "from doctr.models import ocr_predictor; ocr_predictor(det_arch='db_resnet50', reco_arch='crnn_vgg16_bn', pretrained=True)" \
  && python -c "import easyocr; easyocr.Reader(['en','ar'], gpu=False)"

# 3) Our code - the only layers rebuilt on a normal code change (seconds).
COPY worker/src ./src
RUN pip install --no-cache-dir --no-deps .

# Fail the build if the OCR stacks cannot load (weights come from step 2, so this is fast).
RUN python -c "import doctr, easyocr, torch, torchvision; print('torch', torch.__version__, 'torchvision', torchvision.__version__)" \
  && python -c "from daftar.ocr_engine import loaded_model_report; import json; r=loaded_model_report(); print(json.dumps(r, indent=2)); assert r['doctr_installed'] and r['easyocr_installed'], r; assert r['models_loaded'], r"

EXPOSE 4711
CMD ["python", "-m", "daftar.worker"]
