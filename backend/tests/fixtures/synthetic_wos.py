"""A tiny, made-up WoS-shaped table (no licensed data) for tests that need the
pipeline to run end to end - e.g. API/worker tests in CI."""

from __future__ import annotations

import pandas as pd

# (UT, authors, author-address map, reprint author+inst, keywords)
_ARTICLES = [
    ("WOS:1", ["Rossi, Anna", "Bianchi, Marco", "Lee, Kim"],
     {"Univ Parma, Dept Med, I-43126 Parma, Italy": ["Rossi, Anna", "Bianchi, Marco"],
      "Mayo Clin, Rochester, MN 55905 USA": ["Lee, Kim"]},
     ("Rossi, Anna", "Univ Parma, Dept Med, I-43126 Parma, Italy"),
     "fetal ultrasound; deep learning; gynecology oncology"),
    ("WOS:2", ["Rossi, Anna", "Verdi, Luca"],
     {"Univ Parma, Dept Med, I-43126 Parma, Italy": ["Rossi, Anna", "Verdi, Luca"]},
     ("Verdi, Luca", "Univ Parma, Dept Med, I-43126 Parma, Italy"),
     "fetal ultrasound; image segmentation; deep learning"),
    ("WOS:3", ["Lee, Kim", "Smith, John"],
     {"Mayo Clin, Rochester, MN 55905 USA": ["Lee, Kim", "Smith, John"]},
     ("Smith, John", "Mayo Clin, Rochester, MN 55905 USA"),
     "fetal ultrasound; deep learning; gynecology oncology"),
    ("WOS:4", ["Wang, Li", "Zhang, Wei", "Smith, John"],
     {"Peking Univ, Dept Cardiol, Beijing 100191, Peoples R China": ["Wang, Li", "Zhang, Wei"],
      "Mayo Clin, Rochester, MN 55905 USA": ["Smith, John"]},
     ("Wang, Li", "Peking Univ, Dept Cardiol, Beijing 100191, Peoples R China"),
     "heart failure; bibliometric analysis; citespace"),
    ("WOS:5", ["Zhang, Wei", "Chen, Yu"],
     {"Fudan Univ, Shanghai 200032, Peoples R China": ["Zhang, Wei", "Chen, Yu"]},
     ("Chen, Yu", "Fudan Univ, Shanghai 200032, Peoples R China"),
     "heart failure; bibliometric analysis; citespace"),
    ("WOS:6", ["Chen, Yu", "Wang, Li", "Hu, Zhixi", "Hu, Zhixi"],  # duplicated author, as in WoS
     {"Fudan Univ, Shanghai 200032, Peoples R China": ["Chen, Yu", "Hu, Zhixi"],
      "Peking Univ, Dept Cardiol, Beijing 100191, Peoples R China": ["Wang, Li"]},
     ("Chen, Yu", "Fudan Univ, Shanghai 200032, Peoples R China"),
     "large language models; ethics; medical education"),
]

ORCIDS = {"Rossi, Anna": "0000-0001-0000-0001", "Wang, Li": "0000-0002-0000-000X"}


def synthetic_wos_df() -> pd.DataFrame:
    rows = []
    for ut, authors, addresses, (rp_author, rp_addr), keywords in _ARTICLES:
        rows.append({
            "UT (Unique WOS ID)": ut,
            "Author Full Names": "; ".join(authors),
            "Article Title": f"Synthetic article {ut}",
            "Source Title": "Journal of Tests",
            "Publication Year": 2025,
            "Document Type": "Article",
            "Addresses": "; ".join(f"[{'; '.join(names)}] {addr}"
                                   for addr, names in addresses.items()),
            "Reprint Addresses": f"{rp_author} (corresponding author), {rp_addr}.",
            "ORCIDs": "; ".join(f"{n}/{o}" for n, o in ORCIDS.items() if n in authors) or None,
            "Author Keywords": keywords,
            "Keywords Plus": None,
        })
    return pd.DataFrame(rows)
