import sys
import os
from pathlib import Path

# Nastavitev delovne poti za cPanel Passenger WSGI strežnik
BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from app import app as application
