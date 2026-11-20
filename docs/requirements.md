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

## Operations (OPS)

### REQ-OPS-1 Health check: Done
- AC1: `/api/health` answers without login. It is used by the smoke test and the post-deploy checks. `backend/tests/api/test_api_auth.py::test_health`

### REQ-OPS-2 The published API and network contracts stay current: Done
- AC1: `docs/openapi.json` and `docs/network.schema.json` match the code. `backend/tests/test_schema.py::test_committed_openapi_is_up_to_date`, `backend/tests/test_schema.py::test_committed_json_schema_is_up_to_date`
