"""Ajoute une ligne au journal des mises à jour.
Usage : python3 journal.py "<étape>" "<statut>" "<détails…>"
Exemple : python3 journal.py GitHub "publié" "commit 1a2b3c4"
"""
import sys
from update import journal

if __name__ == '__main__':
    journal(*sys.argv[1:])
