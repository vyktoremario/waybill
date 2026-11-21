-- Waybill schema. Money is bigint kobo. Times are timestamptz. See docs/SPEC.md §5.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  role          text NOT NULL CHECK (role IN ('dispatcher', 'driver')),
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE drivers (
  user_id        uuid PRIMARY KEY REFERENCES users(id),
  status         text NOT NULL DEFAULT 'offline' CHECK (status IN ('offline', 'available', 'busy')),
  vehicle        text NOT NULL CHECK (vehicle IN ('bike', 'car', 'van')),
  phone          text,
  last_location  geography(Point, 4326),
  last_seen_at   timestamptz,
  last_seq       bigint NOT NULL DEFAULT -1,
  idle_since     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drivers_location_idx ON drivers USING gist (last_location);

CREATE TABLE orders (
  id                   uuid PRIMARY KEY,
  status               text NOT NULL,
  version              integer NOT NULL DEFAULT 0,
  customer_name        text NOT NULL,
  customer_phone       text NOT NULL,
  customer_email       text NOT NULL,
  receiver_name        text NOT NULL,
  pickup_address       text NOT NULL,
  pickup_location      geography(Point, 4326) NOT NULL,
  dropoff_address      text NOT NULL,
  dropoff_location     geography(Point, 4326) NOT NULL,
  item                 text NOT NULL,
  package_size         text NOT NULL CHECK (package_size IN ('small', 'medium', 'large')),
  distance_meters      integer NOT NULL,
  price_kobo           bigint NOT NULL CHECK (price_kobo > 0),
  driver_id            uuid REFERENCES drivers(user_id),
  tracking_token_hash  text NOT NULL UNIQUE,
  pin_hash             text NOT NULL,
  pin_salt             text NOT NULL,
  pin_failed_attempts  integer NOT NULL DEFAULT 0,
  pin_window_started   timestamptz,
  pickup_photo_id      text,
  cancel_reason        text,
  paid_at              timestamptz,
  needs_attention      boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_driver_idx ON orders (driver_id) WHERE driver_id IS NOT NULL;

-- Append-only audit trail; one row per transition. command_id makes driver/dispatcher commands idempotent.
CREATE TABLE order_events (
  id           bigserial PRIMARY KEY,
  order_id     uuid NOT NULL REFERENCES orders(id),
  seq          integer NOT NULL,
  type         text NOT NULL,
  from_status  text,
  to_status    text NOT NULL,
  actor        text NOT NULL,
  actor_id     text,
  command_id   uuid UNIQUE,
  payload      jsonb NOT NULL DEFAULT '{}',
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, seq)
);

CREATE TABLE offers (
  id          uuid PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id),
  driver_id   uuid NOT NULL REFERENCES drivers(user_id),
  status      text NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'withdrawn')),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz
);
-- At most one pending offer per order, and per driver.
CREATE UNIQUE INDEX offers_one_pending_per_order ON offers (order_id) WHERE status = 'pending';
CREATE UNIQUE INDEX offers_one_pending_per_driver ON offers (driver_id) WHERE status = 'pending';

CREATE TABLE payments (
  id                  uuid PRIMARY KEY,
  order_id            uuid NOT NULL REFERENCES orders(id),
  provider            text NOT NULL,
  provider_reference  text NOT NULL UNIQUE,
  idempotency_key     text NOT NULL UNIQUE,
  amount_kobo         bigint NOT NULL CHECK (amount_kobo > 0),
  currency            text NOT NULL DEFAULT 'NGN',
  status              text NOT NULL CHECK (status IN ('initiated', 'succeeded', 'failed', 'refund_pending', 'refunded')),
  checkout_url        text,
  -- 'primary' pays for the order; 'extra' is a duplicate or late payment that must be refunded.
  role                text CHECK (role IN ('primary', 'extra')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- An order is paid by at most one payment; anything else is refunded.
CREATE UNIQUE INDEX payments_one_primary_per_order ON payments (order_id) WHERE role = 'primary';

CREATE TABLE refunds (
  id                  uuid PRIMARY KEY,
  payment_id          uuid NOT NULL UNIQUE REFERENCES payments(id),
  amount_kobo         bigint NOT NULL,
  reason              text NOT NULL,
  status              text NOT NULL CHECK (status IN ('requested', 'pending', 'processed')),
  provider_refund_id  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Webhook inbox: dedupes provider deliveries.
CREATE TABLE inbox (
  provider      text NOT NULL,
  event_id      text NOT NULL,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- Transactional outbox, relayed to RabbitMQ by the worker.
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  message_id    uuid NOT NULL UNIQUE,
  type          text NOT NULL,
  aggregate_id  text,
  payload       jsonb NOT NULL,
  delay_ms      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      integer NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

CREATE FUNCTION outbox_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('outbox_new', '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER outbox_notify AFTER INSERT ON outbox FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify();

-- Makes each RabbitMQ consumer idempotent.
CREATE TABLE processed_messages (
  consumer      text NOT NULL,
  message_id    uuid NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, message_id)
);

-- Double-entry ledger. Every entry_group sums to zero (checked by a deferred constraint trigger).
CREATE TABLE ledger_entries (
  id           bigserial PRIMARY KEY,
  entry_group  uuid NOT NULL,
  account      text NOT NULL,
  order_id     uuid REFERENCES orders(id),
  payment_id   uuid REFERENCES payments(id),
  amount_kobo  bigint NOT NULL,
  memo         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_group_idx ON ledger_entries (entry_group);
CREATE INDEX ledger_order_idx ON ledger_entries (order_id);

CREATE FUNCTION ledger_group_balances() RETURNS trigger AS $$
DECLARE total bigint;
BEGIN
  SELECT COALESCE(SUM(amount_kobo), 0) INTO total FROM ledger_entries WHERE entry_group = NEW.entry_group;
  IF total <> 0 THEN
    RAISE EXCEPTION 'ledger group % does not balance (sum %)', NEW.entry_group, total;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER ledger_group_balances AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_group_balances();

CREATE TABLE location_points (
  id           bigserial PRIMARY KEY,
  driver_id    uuid NOT NULL REFERENCES drivers(user_id),
  order_id     uuid REFERENCES orders(id),
  seq          bigint NOT NULL,
  recorded_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  location     geography(Point, 4326) NOT NULL,
  accuracy     real,
  speed        real,
  heading      real,
  UNIQUE (driver_id, seq)
);
CREATE INDEX location_points_order_idx ON location_points (order_id, recorded_at);

CREATE TABLE photos (
  id          text PRIMARY KEY,
  driver_id   uuid NOT NULL REFERENCES drivers(user_id),
  mime        text NOT NULL,
  bytes       bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
