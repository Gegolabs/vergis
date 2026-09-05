#!/usr/bin/env python3
"""Genera los HTML ESPERADOS de `report`/`print` corriendo el `server.py` de Daftar sobre las
fixtures SINTÉTICAS de este directorio. Es el instrumento que vuelve MEDIDA la paridad del port a
TypeScript: sin él, «fiel» sería un juicio.

    python3 tests/fixtures/daftar/generar-esperados.py [ruta/al/server.py]

No se corre en el gate (exige el árbol de Daftar, que vive fuera del repo): los esperados se
COMMITEAN y la suite compara contra ellos. Regenerarlos es un acto deliberado, y el diff del commit
es la evidencia de qué cambió.
"""
import importlib.util
import json
import sys
from pathlib import Path

AQUI = Path(__file__).parent
DEFECTO = "/Users/cesar/wworkspace/estudios/daftar/app/server.py"

ESTUDIANTES = {
    "ana": {"name": "Ana Sintética", "grade": "1° Medio"},
    "beto": {"name": "Beto Sintético", "grade": "2° Medio"},
}


def cargar(server_py):
    sys.argv = ["server.py", "--port", "8080"]
    spec = importlib.util.spec_from_file_location("daftar_server", server_py)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.STUDENT_INFO = ESTUDIANTES
    return mod


def main():
    server_py = sys.argv[1] if len(sys.argv) > 1 else DEFECTO
    mod = cargar(server_py)
    casos = json.loads((AQUI / "casos.json").read_text(encoding="utf-8"))
    dest = AQUI / "esperado"
    dest.mkdir(exist_ok=True)
    for nombre, caso in sorted(casos.items()):
        guia, prog = caso["guide"], caso["progress"]
        (dest / f"{nombre}.report.html").write_text(mod.render_report(guia, prog), encoding="utf-8")
        (dest / f"{nombre}.print.html").write_text(mod.render_print(guia, prog), encoding="utf-8")
        (dest / f"{nombre}.print-blank.html").write_text(
            mod.render_print(guia, {}, blank=True), encoding="utf-8"
        )
        print(f"  {nombre}: report + print + print-blank")


if __name__ == "__main__":
    main()
