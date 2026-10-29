"""Prove a digest mismatch is rejected even when Python removes assertions."""
import subprocess
import sys
from pathlib import Path

validator = Path(__file__).with_name("verify-approved-inputs.py")
program = """
import hashlib, runpy, sys
class WrongDigest:
    def hexdigest(self): return '0' * 64
hashlib.file_digest = lambda *args: WrongDigest()
runpy.run_path(sys.argv[1], run_name='__main__')
"""
result = subprocess.run([sys.executable, "-O", "-c", program, str(validator)], capture_output=True, text=True, encoding="utf-8", timeout=20)
if result.returncode == 0 or "Approved ZIP SHA-256 mismatch" not in result.stderr:
    raise RuntimeError("Optimized validator failed to reject a wrong digest")
print("PASS: python -O rejects an incorrect approved ZIP digest before writing approval metadata.")
