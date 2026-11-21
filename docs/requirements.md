# Requirements and acceptance criteria

What EntityNetworks must do, written as user stories with acceptance criteria
(AC). Every AC names the tests that prove it, as `file::test name`. A Python test
is named by its function, and a TypeScript test by the string passed to `it(...)` or
`test(...)`.

`backend/tests/test_requirements_trace.py` checks in CI that every AC lists at
least one test and that every listed test exists. When a test is renamed or
deleted, this file has to change with it.

**Who maintains it:** the `analyst` agent adds and changes stories (see
[`workflow.md`](workflow.md#agents-who-does-what)). You approve them before
development starts. Status is *Done* once CI passes on `main` with the tests listed.

IDs never change and are never reused. A requirement that is dropped stays
here, marked *Withdrawn*.

---

## Accounts (AUTH)

### REQ-AUTH-1 Register: Done
*As a researcher, I want to create an account with my email and a password, so that my datasets are mine.*
- AC1: Registering logs the user in with secure session cookies. `backend/tests/api/test_api_auth.py::test_register_sets_secure_session_cookies`
- AC2: An email that is already registered, or a weak password, is rejected. `backend/tests/api/test_api_auth.py::test_register_rejects_duplicate_and_weak`
- AC3: Registration can be turned off per environment (it is off on QA and PROD). `backend/tests/api/test_api_auth.py::test_registration_can_be_disabled`

### REQ-AUTH-2 Log in and out: Done
*As a user, I want to log in and out safely.*
- AC1: A wrong email gets the same answer as a wrong password. `backend/tests/api/test_api_auth.py::test_login_and_failures_look_the_same`
- AC2: Repeated failed logins are rate-limited. `backend/tests/api/test_api_auth.py::test_login_rate_limited`
- AC3: Logging out ends the session, and the old cookie no longer works. Expired sessions are rejected. `backend/tests/api/test_api_auth.py::test_logout_needs_csrf_and_invalidates_session`, `backend/tests/api/test_api_auth.py::test_stolen_cookie_unusable_after_logout`, `backend/tests/api/test_api_auth.py::test_expired_session_rejected`
- AC4: A logged-out visitor is sent to the login page, sees server errors there, and enters the app after logging in. `frontend/src/pages/pages.test.tsx::redirects to login when logged out, shows server errors, then enters the app`, `frontend/e2e/smoke.spec.ts::upload, build and explore a network`

### REQ-AUTH-3 Only logged-in users reach data: Done
- AC1: Every endpoint except health and login needs a session. `backend/tests/api/test_api_auth.py::test_protected_endpoints_need_login`

### REQ-AUTH-4 Reset a forgotten password: Done
*As a user who forgot my password, I want a reset link by email.*
- AC1: A known and an unknown email get the same answer, and inactive users get no link. `backend/tests/api/test_api_password_reset.py::test_unknown_and_known_email_get_the_same_answer`, `backend/tests/api/test_api_password_reset.py::test_inactive_user_gets_no_link`
- AC2: The link sets a new password and ends all existing sessions. `backend/tests/api/test_api_password_reset.py::test_reset_sets_password_and_ends_sessions`, `frontend/e2e/password-reset.spec.ts::reset a forgotten password by emailed link`
- AC3: A link works once, expires, and is voided by a newer request. Bogus tokens and weak passwords are rejected. `backend/tests/api/test_api_password_reset.py::test_token_is_single_use`, `backend/tests/api/test_api_password_reset.py::test_new_request_voids_older_links`, `backend/tests/api/test_api_password_reset.py::test_expired_and_bogus_tokens_rejected`, `backend/tests/api/test_api_password_reset.py::test_weak_password_rejected`
- AC4: Reset requests are rate-limited. Without SMTP settings, the link is written to the log. `backend/tests/api/test_api_password_reset.py::test_reset_is_rate_limited`, `backend/tests/api/test_api_password_reset.py::test_without_smtp_the_link_is_logged`
- AC5: The UI asks for a link from the login page, sets the new password, and explains an expired link. `frontend/src/pages/pages.test.tsx::asks for a link from the login page and shows the neutral answer`, `frontend/src/pages/pages.test.tsx::sets a new password with the token from the link`, `frontend/src/pages/pages.test.tsx::explains an expired link and offers a new one`

### REQ-AUTH-5 Admin manages accounts on a server: Done
- AC1: An admin can set a user's password from the command line, which also ends their sessions. `backend/tests/api/test_api_password_reset.py::test_manage_set_password`

## Datasets (DATA)

### REQ-DATA-1 Upload a WoS export: Done
*As a researcher, I want to upload the `.xls` files Web of Science exports.*
- AC1: Uploaded files are stored under random names. `backend/tests/api/test_api_datasets.py::test_upload_stores_files_under_random_names`
- AC2: A rejected upload leaves nothing behind. Uploads need the CSRF header. `backend/tests/api/test_api_datasets.py::test_upload_rejections_leave_nothing_behind`, `backend/tests/api/test_api_datasets.py::test_upload_requires_csrf`
- AC3: After the upload, the UI opens the new dataset. `frontend/src/pages/pages.test.tsx::uploads files with the CSRF header and opens the new dataset`, `frontend/e2e/smoke.spec.ts::upload, build and explore a network`

### REQ-DATA-2 My data is private: Done
- AC1: Datasets, data pages, network options and networks are visible only to their owner. `backend/tests/api/test_api_datasets.py::test_datasets_are_private`, `backend/tests/api/test_api_profile.py::test_profile_is_private`, `backend/tests/api/test_api_profile.py::test_network_options_are_private`, `backend/tests/api/test_api_runs.py::test_runs_are_private`

### REQ-DATA-3 See what a dataset contains: Done
*As a researcher, I want to see which authors, institutions, countries, journals, funders and topics my export contains.*
- AC1: The worker profiles each upload, listing the top 20 values per field. `backend/tests/api/test_api_profile.py::test_profile_lifecycle`, `backend/tests/test_profile.py::test_profile_of_synthetic_dataset`, `backend/tests/test_profile.py::test_catalog_lists_the_top_20_values`
- AC2: Unreadable files mark the profile as failed instead of crashing. Missing WoS columns are tolerated. `backend/tests/api/test_api_profile.py::test_unreadable_files_mark_profile_failed`, `backend/tests/test_profile.py::test_profile_tolerates_missing_wos_columns`
- AC3: The data page shows the profile. `frontend/src/pages/pages.test.tsx::shows the data page from a real pipeline profile`, `frontend/e2e/smoke.spec.ts::upload, build and explore a network`

### REQ-DATA-4 Delete a dataset: Done
- AC1: Deleting a dataset removes its files and networks. `backend/tests/api/test_api_datasets.py::test_delete_dataset_removes_files_and_runs`, `frontend/e2e/smoke.spec.ts::upload, build and explore a network`

## Networks (NET)

### REQ-NET-1 Co-authorship network: Done
*As a researcher, I want to see who publishes with whom.*
- AC1: The network built from the reference export equals the golden snapshot, both directly and through upload and worker. `backend/tests/test_pipeline_golden.py::test_matches_golden`, `backend/tests/api/test_api_e2e_real_data.py::test_real_upload_reproduces_golden`
- AC2: One click in the UI builds it, and the worker runs it. `backend/tests/api/test_api_runs.py::test_worker_builds_network`, `frontend/e2e/smoke.spec.ts::upload, build and explore a network`

### REQ-NET-2 Institutions by shared keywords: Done
*As a researcher, I want to find institutions working on my topics, even if they never wrote together.*
- AC1: The network is built with the options the user chose. `backend/tests/api/test_api_runs.py::test_worker_institution_network_with_params`, `frontend/src/pages/pages.test.tsx::builds an institution network with the chosen options`
- AC2: The custom builder with the same settings reproduces this preset. `backend/tests/test_custom_network.py::test_corresponding_institution_keywords_reproduces_the_preset`

### REQ-NET-3 Custom network: Done
*As a researcher, I want to choose the nodes, the field that links them and how strict the match must be.*
- AC1: Only compatible node / link field / model combinations are offered and accepted. `backend/tests/test_custom_network.py::test_combination_rules`, `backend/tests/test_custom_network.py::test_invalid_combination_is_refused_before_reading_data`, `frontend/src/pages/pages.test.tsx::builds a custom network, keeping nodes, link field and model compatible`
- AC2: The options follow what the dataset actually contains. `backend/tests/api/test_api_profile.py::test_network_options_follow_the_profile`, `backend/tests/test_custom_network.py::test_availability_follows_column_fill`
- AC3: A network that would be too large, or that needs columns the data lacks, fails with a readable message. `backend/tests/test_custom_network.py::test_too_many_pairs_fail_with_a_message`, `backend/tests/api/test_api_runs.py::test_custom_run_with_missing_columns_fails_with_a_message`
- AC4: The worker builds custom runs. `backend/tests/api/test_api_runs.py::test_custom_run_is_built_by_the_worker`

### REQ-NET-4 Every network follows the published format: Done
- AC1: Every network conforms to `docs/network.schema.json`, and invalid ones are rejected. `backend/tests/test_schema.py::test_goldens_conform_and_round_trip`, `backend/tests/test_schema.py::test_invalid_networks_rejected`, `backend/tests/test_custom_network.py::test_every_combination_the_synthetic_data_supports_builds_a_valid_network`

### REQ-NET-5 Networks build in the background, reliably: Done
- AC1: A run is queued with its full parameters and picked up by exactly one worker. `backend/tests/api/test_api_runs.py::test_run_is_queued_with_full_default_params`, `backend/tests/api/test_api_runs.py::test_only_one_worker_can_hold_the_lock`, `backend/tests/api/test_api_runs.py::test_claim_skips_runs_locked_by_another_worker`
- AC2: Interrupted runs are retried, then fail with a message. Unreadable uploads fail with a message. `backend/tests/api/test_api_runs.py::test_orphaned_runs_requeued_then_failed`, `backend/tests/api/test_api_runs.py::test_unreadable_upload_fails_with_message`

## Explore (EXP)

### REQ-EXP-1 Explore the network interactively: Done
- AC1: The explorer shows the graph with node and link counts, everything visible at first. `frontend/src/components/explorer/Explorer.test.tsx::starts with everything visible`, `frontend/e2e/smoke.spec.ts::upload, build and explore a network`
- AC2: The Explore tab opens the dataset's newest network, or the one last opened. `frontend/src/pages/pages.test.tsx::opens the dataset's newest finished network and marks the Explore tab`, `frontend/src/pages/pages.test.tsx::returns to the network last opened for that dataset`

### REQ-EXP-2 Filter by group and relationship: Done
- AC1: Unchecking a group hides its nodes and their links everywhere (graph, counts, JSON). `frontend/src/components/explorer/Explorer.test.tsx::Group checkbox hides nodes everywhere (graph, count, JSON)`, `frontend/src/lib/visibility.test.ts::hide nodes of unchecked teams and every edge touching them`
- AC2: The filter list is the legend: largest groups first, other/unknown last. `frontend/src/components/explorer/Explorer.test.tsx::filter list doubles as the legend: largest groups first, other/unknown last`
- AC3: Unchecking a relationship hides its links but never their nodes. `frontend/src/lib/visibility.test.ts::hide edges of unchecked types but never their nodes`

### REQ-EXP-3 Search by name or attribute: Done
- AC1: Name search highlights matches and never hides anything. `frontend/src/components/explorer/Explorer.test.tsx::name search highlights only, never hides`
- AC2: Attribute search filters on Apply. Alternatives within a row are separated by ";" and ORed, and rows are ANDed. `frontend/src/components/explorer/Explorer.test.tsx::attribute search filters only on Apply; OR within a row, AND across rows`, `frontend/src/lib/visibility.test.ts::splits terms on ';', trims, lower-cases and drops empty rows`

### REQ-EXP-4 Keep only the strongest links: Done
- AC1: A link weight range hides links outside it. Optionally, it also hides the nodes left unlinked. `frontend/src/components/explorer/Explorer.test.tsx::link weight range hides links by weight; the checkbox hides nodes left unlinked`, `frontend/src/lib/visibility.test.ts::hides links outside the range but keeps the nodes`

### REQ-EXP-5 See why a node or link is there: Done
- AC1: Nodes carry their article counts and links their evidence. `backend/tests/test_custom_network.py::test_nodes_carry_article_counts_and_edges_their_evidence`
- AC2: Tapping a link shows it and marks it in the JSON panel. `frontend/src/components/explorer/Explorer.test.tsx::tapping a link in the graph shows the link and marks it in the JSON`

### REQ-EXP-6 Download the network: Done
- AC1: The network downloads as a JSON attachment, the same as the API returns. `backend/tests/api/test_api_runs.py::test_worker_builds_network`
- AC2: The download link sits below the graph. `frontend/src/components/explorer/Explorer.test.tsx::shows the back link above the title and the footer below the graph`

## Records (REC)

A tab after "Explore" that shows the uploaded article rows of a dataset (the records of
the WoS export) as a compact, filterable table. It lets a user check against the
source data what a network shows. It is not a spreadsheet: it is read-only, shows
one page at a time, and starts with a small set of columns.

*Notes and constraints (from CLAUDE.md and the code, not solutions):* no new service; the
records live in the existing stack (`deploy/compose.yaml` stays as it is). Uploaded
files are read only by the worker. Datasets profiled before this feature must get their
records without being uploaded again. Networks use derived values (institutions parsed from
"Addresses", keywords as the normalized union of "Author Keywords" and "Keywords Plus"),
so the table must be able to show and filter on those same values. "Keywords Plus" are
generated by WoS from cited-reference titles, not chosen by the authors.

*Out of scope for now:* derived columns other than institutions and keywords, a
user-chosen page size (it is fixed at 50), and CSV download (REQ-REC-7, deferred).

### REQ-REC-1 Browse the records of a dataset: In progress
*As a researcher, I want to page through the articles of my upload in a compact table, so that I can check what the source data says.*
- AC1: A "Records" tab appears after "Explore". It opens the records of the current dataset (from the URL or the open network), and is marked active on that page. With no current dataset, it asks the user to pick a dataset, as "View data" does. `frontend/src/pages/pages.test.tsx::shows the Records tab after Explore and follows the current dataset`
- AC2: The table shows 50 records per page (fixed; the user cannot change it) with previous/next page controls and the text "N of M records", where M is the number of records in the dataset and N the number that match the current filters (N = M without filters). `frontend/src/pages/pages.test.tsx::pages through records 50 at a time and shows N of M records`
- AC3: The records are every article row of the dataset's uploaded files, in upload order, with duplicates kept: the same rows the networks are built from. M equals the article count on the data page. `backend/tests/test_profile.py::test_records_keep_every_article_row`
- AC4: By default the table shows a small set of columns, in this order, skipping those the export lacks: UT, Article Title, Author Full Names, Publication Year, Document Type, Source Title, Author Keywords, Keywords Plus, Institutions (parsed). "Institutions (parsed)" is shown when the export has "Addresses". The raw "Addresses" column is not in the default set, but it can be shown with the column picker. `frontend/src/pages/pages.test.tsx::shows the default record columns that the export has`
- AC5: A cell longer than its column is cut to one line and ends with "…". The table never grows wider than the page. `frontend/src/pages/pages.test.tsx::cuts long record cells to one line`
- AC6: Clicking a row opens a detail view of that record with every column of the export, including the derived columns of REQ-REC-4. Empty fields are shown as "(empty)". Closing it returns to the same page, filters and scroll position. `frontend/src/pages/pages.test.tsx::opens a record with all its fields and returns to the same page`
- AC7: While the dataset's profile is pending, the tab shows the same pending message as the data page and no table. If profiling failed, it shows the failure message. `frontend/src/pages/pages.test.tsx::shows the records empty state while the profile is pending or failed`, `backend/tests/api/test_api_profile.py::test_unstorable_upload_fails_and_the_worker_moves_on`

### REQ-REC-2 Choose and sort columns: In progress
*As a researcher, I want to show only the columns I care about and sort by one, so that the table stays readable.*
- AC1: A column picker lists every column of the export plus the derived columns, each with a checkbox to show or hide it. The last visible column cannot be hidden. `frontend/src/pages/pages.test.tsx::shows and hides record columns with the column picker`
- AC2: The column choice is remembered per dataset in this browser: reloading the page or coming back later shows the same columns, and other datasets keep their own choice. "Reset columns" restores the default set. `frontend/src/pages/pages.test.tsx::remembers the record columns per dataset`
- AC3: Clicking a column header sorts all matching records by that column (not only the current page): first ascending, then descending, then back to upload order. Empty values come last in both directions. Text is compared case-insensitively, and Publication Year as a number. `backend/tests/api/test_api_profile.py::test_records_sort_by_a_column`, `frontend/src/pages/pages.test.tsx::sorts records by a column header`

### REQ-REC-3 Filter records: In progress
*As a researcher, I want to filter the records by column values, so that I can find the articles behind a node or a link.*
- AC1: Each filter row has a column (any column, visible or not), an operator ("contains", "does not contain", "has item", "is empty", "is not empty") and a value. The value box is disabled for "is empty" and "is not empty". Nothing is filtered until the user clicks Apply, and Clear removes every filter. `frontend/src/pages/pages.test.tsx::filters records only on Apply and clears them`
- AC2: As in the explorer's attribute search (REQ-EXP-3), ";" separates alternatives within one value, which are ORed, and filter rows are ANDed. Terms are trimmed and matched case-insensitively, and empty terms are dropped. "does not contain a; b" keeps records that contain neither "a" nor "b". On "Author Keywords", "Keywords Plus" and "Keywords (normalized)", "contains" and "does not contain" also treat hyphens as spaces, as the keyword networks do (terms normalized the same way), so "contains machine learning" matches "Machine-Learning"; other columns compare hyphens as typed. `backend/tests/api/test_api_profile.py::test_record_filters_or_within_a_row_and_across_rows`, `backend/tests/api/test_api_profile.py::test_contains_on_keyword_columns_treats_hyphens_as_spaces`, `frontend/src/lib/records.test.ts::treats hyphens as spaces in keyword columns only, as the server does`
- AC3: Filters apply to all records of the dataset, and N in "N of M records" counts the matches. When nothing matches, the table says "No records match these filters." `backend/tests/api/test_api_profile.py::test_record_filters_apply_to_all_records`, `frontend/src/pages/pages.test.tsx::says when no records match the filters`
- AC4: The text that a "contains" filter matched, and the items that a "has item" filter matched, are highlighted in the table cells and in the detail view. `frontend/src/pages/pages.test.tsx::highlights the matched text in record cells`
- AC5: The filters, the sort and the page number are part of the page URL, so reloading or reopening the URL shows the same view. A filter on a column the dataset doesn't have is dropped, and the page says "Ignored a filter on an unknown column: <name>." `frontend/src/pages/pages.test.tsx::restores record filters, sort and page from the URL`
- AC6: "has item" matches whole items only. A cell is split on ";", its items are trimmed, and a record matches when one item equals one of the filter's terms, case-insensitively. For "Author Keywords", "Keywords Plus" and "Keywords (normalized)", both the items and the terms are normalized as the keyword networks do (lower case, hyphens as spaces). For example, "has item: learning" does not match "machine learning", and "has item: machine learning" matches "Machine-Learning". In a column without ";", the whole cell is the one item. `backend/tests/api/test_api_profile.py::test_has_item_matches_whole_items_only`

### REQ-REC-4 See the values the network used: In progress
*As a researcher, I want columns with the institutions and keywords exactly as the network derived them, so that a filter matches what the network matched.*
- AC1: The column "Institutions (parsed)" lists, for each record, the institutions that the "Institution (all authors)" networks derive from its "Addresses", with the same names as the network's nodes, separated by "; ". `backend/tests/test_profile.py::test_parsed_institutions_match_the_network_nodes`
- AC2: The column "Keywords (normalized)" lists, for each record, the union of its "Author Keywords" and "Keywords Plus" normalized as the keyword networks do (lower case, hyphens as spaces, no duplicates), with the same spelling as a link's shared items. For example, "Machine-Learning" in Author Keywords appears as "machine learning". `backend/tests/test_profile.py::test_normalized_keywords_match_the_network_items`
- AC3: In the column picker and the table header, derived columns are marked "derived, not in the export". "Institutions (parsed)" is in the default set (REQ-REC-1 AC4), and "Keywords (normalized)" is hidden by default. `frontend/src/pages/pages.test.tsx::marks derived record columns and shows only Institutions (parsed) by default`

### REQ-REC-5 From a node or link to its records: In progress
*As a researcher who doesn't trust a link, I want to open the records behind it in one click, so that I can see whether the shared values really appear there.*
- AC1: When a node is selected in the explorer, and its type maps to a records column (author: Author Full Names; institution (all authors): Institutions (parsed); journal: Source Title; organization: Affiliations; funder: Funding Orgs; WoS category: WoS Categories; research area: Research Areas; article: UT), the panel shows "Show records". Other node types don't show the action. `frontend/src/components/explorer/Explorer.test.tsx::offers Show records only for nodes whose type maps to a records column`
- AC2: "Show records" on a node opens the Records tab of the network's dataset with one filter: <mapped column> contains <node name>. The column is shown even if hidden. `frontend/src/components/explorer/Explorer.test.tsx::Show records on a node opens Records filtered on its value`, `frontend/src/pages/pages.test.tsx::shows the filtered columns when opened from the explorer`
- AC3: When a link is selected whose node type maps to a column (AC1) and whose link field is "Keywords", "Author keywords" or "Keywords Plus", "Show records" opens the Records tab with two filters: <node column> contains <endpoint A>; <endpoint B>, AND <keyword column> contains <the link's shared items, ";"-separated>. The keyword column is "Keywords (normalized)" for "Keywords". For "Author keywords" and "Keywords Plus" it is the raw column of that name. Both columns are shown. For links on other link fields, the action is not offered. `frontend/src/components/explorer/Explorer.test.tsx::Show records on a keyword link filters on both endpoints and the shared items`, `frontend/src/pages/pages.test.tsx::shows the filtered columns when opened from the explorer`
- AC4: A user can go from a keyword link between two institutions in the explorer to the records that carry its shared keywords, and see the matched keywords highlighted. `frontend/e2e/smoke.spec.ts::check a link's records from the explorer`
- AC5: When the Records tab is opened from a link, it shows this one-line note above the table: "The network file keeps at most 20 shared items per link and skips keywords used in too many articles, so these records may differ from the link." The note is not shown when the tab is opened from a node or directly. `frontend/src/pages/pages.test.tsx::notes that records opened from a link may differ from the link`

### REQ-REC-6 Records are stored with the dataset and stay private: In progress
- AC1: When the worker profiles an upload, the dataset's records become available, with no further action by the user. `backend/tests/api/test_api_profile.py::test_profiling_makes_records_available`
- AC2: A dataset profiled before this feature gets its records through the worker's profile refresh, without being uploaded again. `backend/tests/api/test_api_profile.py::test_profile_refresh_adds_records_to_older_datasets`, `backend/tests/api/test_api_profile.py::test_unstorable_refresh_is_remembered`
- AC3: Records are visible only to the dataset's owner. Another logged-in user gets 404, as for the profile (REQ-DATA-2). `backend/tests/api/test_api_profile.py::test_records_are_private`
- AC4: One request returns at most one page of records, and only the columns asked for, together with the total and matching counts. `backend/tests/api/test_api_profile.py::test_records_are_paginated`, `backend/tests/api/test_api_profile.py::test_record_filters_are_bounded`
- AC5: Deleting a dataset deletes its records too (REQ-DATA-4). `backend/tests/api/test_api_datasets.py::test_delete_dataset_removes_its_records`

### REQ-REC-7 Download the filtered records as CSV: Deferred
*As a researcher, I want to download the records I filtered, so that I can keep them as evidence or open them elsewhere.*

Not in this release. Its acceptance criteria will be written when it is scheduled. Until then, these are the intended criteria, in plain text:
- "Download CSV" below the table downloads the records that match the current filters, in the current sort, with the visible columns, as a UTF-8 CSV attachment named `<dataset name>-records.csv`.
- The download is owner-only, like the records (REQ-REC-6 AC3).

## Operations (OPS)

### REQ-OPS-1 Health check: Done
- AC1: `/api/health` answers without login. It is used by the smoke test and the post-deploy checks. `backend/tests/api/test_api_auth.py::test_health`

### REQ-OPS-2 The published API and network contracts stay current: Done
- AC1: `docs/openapi.json` and `docs/network.schema.json` match the code. `backend/tests/test_schema.py::test_committed_openapi_is_up_to_date`, `backend/tests/test_schema.py::test_committed_json_schema_is_up_to_date`
