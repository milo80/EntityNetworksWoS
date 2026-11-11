# Legacy demo (reference only)

The original quick demo, kept unchanged as the behavioral reference while the
code moves into `backend/pipeline/` and `frontend/`. Do not edit.

- `entity_relation_generator12.py` - original pipeline (WoS .xls -> network JSON)
- `graph_network_prototype2.html` - original Cytoscape.js viewer (open in a browser, load a JSON)
- `outputs/` - JSON produced by the script; used as golden references for tests
- `WoS` - symlink to `../data/wos` (raw exports, not in git)
- `unit_tests.py` - broken: imports `entity_relation_generator8`, which no longer exists

Run the original script (writes JSON into `legacy/`):

    cd legacy && python entity_relation_generator12.py
