# branch flow

rough -> preview -> main

rough retains the implementation, experiments and design work. preview holds selected working code for review. main holds validated application code, assets, config and tests, without project docs, plans, generated reports or explanatory code comments. secrets and runtime data are never versioned.

the first 25 development commits were reconstructed from uncommitted work using the user-approved 13–14 november 2026 ist timestamps. these are assigned git metadata dates, not recovered edit times. the existing initial commit was left unchanged. later branch preparation commits use their actual creation time.

the default remote branch remains master until explicitly changed. main is prepared locally; release promotion follows preview review.
