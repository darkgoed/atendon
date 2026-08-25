-- Meeting confirmation delivery is now coordinated with the active AI turn,
-- so the durable fallback can be enabled globally without racing the normal
-- reply. The kill switch and explicit tenant overrides remain available for
-- emergency operations.

UPDATE feature_flag_definitions
SET global_enabled=true,
    description='Entrega durável da confirmação e do link Google Meet',
    updated_at=now()
WHERE flag_key='scheduling_meet_outbox_v2';
