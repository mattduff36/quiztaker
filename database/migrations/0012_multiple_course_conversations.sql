-- A browser can remain open across multiple tasks. Keep each task's memory
-- separately while retaining the existing owner/helper/browser access scope.
alter table learner_sessions
  drop constraint if exists learner_sessions_user_id_helper_id_browser_session_id_key;

-- learner_sessions_scope_idx already supports selecting the latest conversation.
