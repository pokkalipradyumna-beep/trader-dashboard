"""Trader Intelligence System — Phase 1 foundation (data quality + coverage).

Independent of the existing weekly 9/21·21/50 engine. Standard library only.
Pluggable interfaces (DataSource, Store) so Yahoo/JSON/offline-batch today can
become licensed-data/DB/automated later without rewriting the engines.
"""
