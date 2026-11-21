import { transition, type DriverCommandType, type OrderEvent, type OrderStatus } from '@waybill/shared';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { HttpError, call, login, logout } from './src/api';
import { setActiveOrder, startTracking, stopTracking } from './src/location';
import { kv, outbox } from './src/store';
import { sync, type SyncState } from './src/sync';
import { c, mono } from './src/theme';
import { Button, Card, ConnectionBanner, StepRow } from './src/ui';

const EVENT_FOR: Partial<Record<DriverCommandType, OrderEvent>> = {
  accept_offer: 'offer_accepted',
  start_trip: 'trip_started',
  confirm_pickup: 'pickup_confirmed',
  start_dropoff: 'dropoff_started',
  confirm_delivery: 'delivery_confirmed',
  report_failed_attempt: 'delivery_failed',
  confirm_return: 'return_confirmed',
};

const uuid = () => Crypto.randomUUID();

/** Server state plus the driver's queued commands, applied optimistically with the shared state machine. */
function optimistic(order: any): any {
  if (!order) return order;
  let status: OrderStatus = order.status;
  for (const row of outbox.all()) {
    if (row.kind !== 'command' || row.order_id !== order.id) continue;
    const event = EVENT_FOR[JSON.parse(row.body).type as DriverCommandType];
    if (!event) continue;
    const r = transition(status, event, 'driver');
    if (r.ok) status = r.to;
  }
  return { ...order, status, pendingLocal: status !== order.status };
}

export default function App() {
  const [signedIn, setSignedIn] = useState(Boolean(kv.get('token')));
  const [s, setS] = useState<SyncState>(sync.snapshot);
  const [current, setCurrent] = useState<any>(() => JSON.parse(kv.get('current') ?? 'null'));
  const [demoOffline, setDemoOffline] = useState(false);

  const refresh = useCallback(async () => {
    if (!kv.get('token') || sync.forcedOffline) return;
    try {
      const cur = await call('/driver/current');
      kv.set('current', JSON.stringify(cur)); // so the app reopens on the right screen without signal
      setCurrent(cur);
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        logout();
        setSignedIn(false);
      }
    }
  }, []);

  useEffect(() => {
    sync.start(() => void refresh());
    return sync.subscribe(setS);
  }, [refresh]);

  useEffect(() => {
    if (!signedIn) return;
    void refresh();
    // Offers and cancellations arrive by polling here; the web dashboard uses WebSockets.
    const t = setInterval(() => void refresh(), 4_000);
    return () => clearInterval(t);
  }, [signedIn, refresh]);

  const order = optimistic(current?.order);
  useEffect(() => setActiveOrder(order?.id), [order?.id]);

  useEffect(() => {
    if (s.rejected) {
      Alert.alert(s.rejected.type === 'confirm_delivery' ? 'Delivery not confirmed' : 'Action refused', s.rejected.message, [{ text: 'OK', onPress: () => sync.clearRejected() }]);
    }
  }, [s.rejected]);

  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />;

  const enqueue = (type: DriverCommandType, orderId: string, payload: Record<string, unknown> = {}) => {
    const commandId = uuid();
    outbox.add({
      id: commandId,
      kind: 'command',
      order_id: orderId,
      body: JSON.stringify({ commandId, orderId, type, occurredAt: new Date().toISOString(), payload }),
    });
    sync.refreshCounts();
    setCurrent((cur: any) => ({ ...cur })); // re-render with the optimistic step
    sync.kick();
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.paper }}>
      <StatusBar style="dark" />
      <View style={{ paddingHorizontal: 20, paddingTop: 12 }}>
        <ConnectionBanner
          s={s}
          demoOffline={demoOffline}
          onToggleDemoOffline={() => {
            sync.setForcedOffline(!demoOffline);
            setDemoOffline(!demoOffline);
          }}
        />
      </View>
      {s.conflict ? (
        <ConflictScreen
          conflict={s.conflict}
          onDone={() => {
            sync.clearConflict();
            void refresh();
          }}
        />
      ) : order ? (
        <ActiveDelivery order={order} online={s.online} enqueue={enqueue} />
      ) : (
        <Home
          current={current}
          online={s.online}
          refresh={refresh}
          onSignOut={() => {
            stopTracking();
            logout();
            setSignedIn(false);
          }}
        />
      )}
    </SafeAreaView>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.paper }}>
      {/* SafeAreaView replaces padding with the safe-area insets on iOS, so pad an inner view. */}
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16 }}>
      <Text style={st.eyebrow}>WAYBILL DRIVER</Text>
      <Text style={st.h1}>Sign in</Text>
      <TextInput accessibilityLabel="Email" placeholder="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} style={st.input} />
      <TextInput accessibilityLabel="Password" placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} style={st.input} />
      <Button
        label={busy ? 'Signing in…' : 'Sign in'}
        disabled={busy}
        onPress={async () => {
          setBusy(true);
          setError(null);
          try {
            await login(email, password);
            onDone();
          } catch (e) {
            setError((e as Error).message === 'Network request failed' ? 'No connection to Waybill. Check your data or Wi-Fi.' : (e as Error).message);
            setBusy(false);
          }
        }}
      />
      {error && <Text style={{ color: c.problem, fontWeight: '600' }}>{error}</Text>}
      </View>
    </SafeAreaView>
  );
}

function Home({ current, online, refresh, onSignOut }: { current: any; online: boolean; refresh: () => Promise<void>; onSignOut: () => void }) {
  const driver = current?.driver;
  const offer = current?.offer;
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  // The offer's full length, taken from when it first appeared, so the bar works for any TTL.
  const ttl = useRef<{ id?: string; seconds: number }>({ seconds: 30 });
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const setAvailability = async (status: 'available' | 'offline') => {
    setBusy(true);
    try {
      if (status === 'available' && !(await startTracking())) {
        Alert.alert('Location needed', 'Waybill needs your location to offer you nearby jobs.', [{ text: 'Open settings', onPress: () => void Linking.openSettings() }, { text: 'Cancel' }]);
        return;
      }
      await call('/driver/availability', { method: 'POST', body: JSON.stringify({ status }) });
      if (status === 'offline') stopTracking();
      await refresh();
    } catch (e) {
      Alert.alert('Could not change status', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Offers are answered online only: accepting offline could take a job the server gave to someone else.
  const answer = async (type: 'accept_offer' | 'decline_offer') => {
    setBusy(true);
    try {
      await call('/driver/commands', { method: 'POST', body: JSON.stringify({ commandId: uuid(), orderId: offer.order.id, type, occurredAt: new Date().toISOString(), payload: {} }) });
    } catch (e) {
      Alert.alert(type === 'accept_offer' ? 'Could not accept' : 'Could not decline', (e as Error).message);
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  if (offer) {
    const o = offer.order;
    const left = Math.max(0, Math.round((new Date(offer.expiresAt).getTime() - now) / 1000));
    if (ttl.current.id !== offer.id) ttl.current = { id: offer.id, seconds: Math.max(left, 1) };
    return (
      <ScrollView contentContainerStyle={st.screen}>
        <Text style={st.eyebrow}>NEW JOB OFFER</Text>
        <Text style={st.h1}>
          {area(o.pickup_address)} → {area(o.dropoff_address)}
        </Text>
        <Text style={st.sub}>{cap(o.package_size)} parcel · already paid</Text>
        <Card style={{ flexDirection: 'row' }}>
          <Stat label="Trip" value={`${(o.distance_meters / 1000).toFixed(1)} km`} />
          <Stat label="You earn" value={`₦${Math.round(o.earningKobo / 100).toLocaleString()}`} last />
        </Card>
        <Card style={{ padding: 16, gap: 12 }}>
          <Place kind="pickup" label="Pickup" address={o.pickup_address} />
          <Place kind="dropoff" label="Drop-off" address={o.dropoff_address} />
        </Card>
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ fontWeight: '600' }}>Offer expires</Text>
            <Text style={mono}>0:{String(left).padStart(2, '0')}</Text>
          </View>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: c.disabledBg }}>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: c.cobalt, width: `${Math.min(100, (left / ttl.current.seconds) * 100)}%` }} />
          </View>
        </View>
        <Button label="Accept job" disabled={busy || !online || left === 0} onPress={() => void answer('accept_offer')} />
        <Button label="Decline" kind="secondary" disabled={busy || !online} onPress={() => void answer('decline_offer')} />
        <Text style={[st.note, { textAlign: 'center' }]}>
          {online ? 'Accepting needs a connection, so no one else gets this job at the same time.' : 'You are offline. Offers can only be accepted online.'}
        </Text>
      </ScrollView>
    );
  }

  const available = driver?.status === 'available';
  return (
    <ScrollView contentContainerStyle={st.screen}>
      <Text style={st.eyebrow}>{driver ? String(driver.vehicle).toUpperCase() : ''}</Text>
      <Text style={st.h1}>{driver ? `Hi ${driver.name.split(' ')[0]}` : 'Waybill'}</Text>
      <Card style={{ padding: 18, gap: 8 }}>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>{available ? 'You are available' : 'You are off duty'}</Text>
        <Text style={st.sub}>{available ? 'Keep the app open. New jobs near you appear here.' : 'Go available to start receiving jobs.'}</Text>
      </Card>
      {available ? (
        <Button label="Stop receiving jobs" kind="secondary" disabled={busy} onPress={() => void setAvailability('offline')} />
      ) : (
        <Button label="Go available" disabled={busy || !online} onPress={() => void setAvailability('available')} />
      )}
      {available && (
        <View style={{ alignItems: 'center', paddingTop: 12 }}>
          <ActivityIndicator color={c.cobalt} />
        </View>
      )}
      <Button label="Sign out" kind="link" onPress={onSignOut} style={{ marginTop: 24 }} />
    </ScrollView>
  );
}

const STEP_LABELS = ['Accepted', 'Picked up · photo saved', 'Drive to drop-off', 'Hand over with PIN'];

function stepIndexFor(status: string): number {
  if (status === 'ASSIGNED' || status === 'EN_ROUTE_TO_PICKUP') return 1;
  if (status === 'PICKED_UP') return 2;
  if (status === 'EN_ROUTE_TO_DROPOFF') return 3;
  return 4;
}

function ActiveDelivery({ order, online, enqueue }: { order: any; online: boolean; enqueue: (t: DriverCommandType, id: string, p?: Record<string, unknown>) => void }) {
  const [screen, setScreen] = useState<'main' | 'photo' | 'pin'>('main');
  const toPickup = ['ASSIGNED', 'EN_ROUTE_TO_PICKUP'].includes(order.status);
  const returning = order.status === 'RETURNING';
  const idx = stepIndexFor(order.status);
  const target = toPickup || returning
    ? { lat: order.pickup_lat, lng: order.pickup_lng, address: order.pickup_address }
    : { lat: order.dropoff_lat, lng: order.dropoff_lng, address: order.dropoff_address };

  if (screen === 'photo') {
    return (
      <PhotoStep
        onCancel={() => setScreen('main')}
        onPhoto={(uri) => {
          const photoId = `p-${uuid()}`;
          // The upload and the pickup command are both queued; the command references the photo by id.
          outbox.add({ id: photoId, kind: 'photo', order_id: order.id, body: JSON.stringify({ uri }) });
          enqueue('confirm_pickup', order.id, { photoId });
          setScreen('main');
        }}
      />
    );
  }
  if (screen === 'pin') {
    return (
      <PinStep
        order={order}
        online={online}
        onCancel={() => setScreen('main')}
        onConfirm={(pin) => {
          enqueue('confirm_delivery', order.id, { pin });
          setScreen('main');
        }}
      />
    );
  }

  if (order.status === 'DELIVERED') {
    return (
      <View style={st.screen}>
        <Text style={st.eyebrow}>DONE</Text>
        <Text style={st.h1}>Delivered</Text>
        <Text style={st.sub}>{order.pendingLocal ? 'Saved on your phone. It syncs when you are back online.' : 'Nice work. You are available for the next job.'}</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={st.screen}>
      <View style={{ gap: 4 }}>
        <Text style={st.eyebrow}>
          {returning ? 'RETURN TO SENDER' : `STEP ${Math.min(idx + 1, 4)} OF 4 · ${toPickup ? 'PICKUP' : 'DROP-OFF'}`}
        </Text>
        <Text style={st.h1}>{target.address}</Text>
        <Text style={st.sub}>
          {toPickup || returning ? `From ${order.customer_name}` : `For ${order.receiver_name}`} · {cap(order.package_size)} parcel · {order.item}
        </Text>
      </View>
      <Card>
        {STEP_LABELS.map((label, i) => (
          <StepRow key={label} label={label} state={i < idx ? 'done' : i === idx ? 'now' : 'next'} right={i === idx ? 'Now' : undefined} />
        ))}
      </Card>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button kind="secondary" label="Call customer" style={{ flex: 1 }} onPress={() => order.customerPhone && void Linking.openURL(`tel:${order.customerPhone}`)} />
        <Button kind="secondary" label="Directions" style={{ flex: 1 }} onPress={() => void Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${target.lat},${target.lng}`)} />
      </View>
      {order.status === 'ASSIGNED' && <Button label="Start trip to pickup" onPress={() => enqueue('start_trip', order.id)} />}
      {order.status === 'EN_ROUTE_TO_PICKUP' && <Button label="Take photo & confirm pickup" onPress={() => setScreen('photo')} />}
      {order.status === 'PICKED_UP' && <Button label="Start drive to drop-off" onPress={() => enqueue('start_dropoff', order.id)} />}
      {order.status === 'EN_ROUTE_TO_DROPOFF' && (
        <>
          <Button label="I've arrived at drop-off" onPress={() => setScreen('pin')} />
          <Button
            kind="danger-link"
            label="Can't deliver"
            onPress={() =>
              Alert.alert("Can't deliver?", 'The parcel goes back to the sender, and dispatch is told.', [
                { text: 'Keep trying', style: 'cancel' },
                { text: 'Receiver not available', onPress: () => enqueue('report_failed_attempt', order.id, { reason: 'receiver not available' }) },
              ])
            }
          />
        </>
      )}
      {returning && <Button label="Confirm returned to sender" onPress={() => enqueue('confirm_return', order.id)} />}
    </ScrollView>
  );
}

function PhotoStep({ onPhoto, onCancel }: { onPhoto: (uri: string) => void; onCancel: () => void }) {
  const [perm, request] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  if (!perm) return null;
  if (!perm.granted) {
    return (
      <View style={st.screen}>
        <Text style={st.h1}>Camera needed</Text>
        <Text style={st.sub}>A photo of the parcel at pickup is your proof, and the customer sees it.</Text>
        <Button label="Allow camera" onPress={() => void request()} />
        <Button label="Back" kind="link" onPress={onCancel} />
      </View>
    );
  }
  return (
    <View style={[st.screen, { flex: 1 }]}>
      <Text style={st.eyebrow}>STEP 2 OF 4 · PICKUP</Text>
      <Text style={st.h1}>Photo of the parcel</Text>
      <Text style={st.sub}>Show the label or the whole parcel. The customer sees this photo.</Text>
      <View style={{ flex: 1, minHeight: 280, borderRadius: 16, overflow: 'hidden', backgroundColor: c.ink }}>
        <CameraView ref={cam} style={{ flex: 1 }} facing="back" />
      </View>
      <Button
        label={busy ? 'Saving…' : 'Take photo & confirm pickup'}
        disabled={busy}
        onPress={async () => {
          setBusy(true);
          const pic = await cam.current?.takePictureAsync({ quality: 0.4 });
          setBusy(false);
          if (pic?.uri) onPhoto(pic.uri);
        }}
      />
      <Button label="Back" kind="link" onPress={onCancel} />
    </View>
  );
}

function PinStep({ order, online, onConfirm, onCancel }: { order: any; online: boolean; onConfirm: (pin: string) => void; onCancel: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const press = (d: string) => {
    setError(null);
    setPin((p) => (d === 'del' ? p.slice(0, -1) : p.length < 4 ? p + d : p));
  };
  const confirm = async () => {
    // Checked on the phone so the driver can finish without signal; the server checks again (ADR-0006).
    const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${order.pinCheck.salt}:${pin}`);
    if (hash !== order.pinCheck.hash) {
      setError("That PIN doesn't match. Ask the receiver to check their tracking page.");
      setPin('');
      return;
    }
    onConfirm(pin);
  };
  return (
    <ScrollView contentContainerStyle={st.screen}>
      <View style={{ gap: 4 }}>
        <Text style={st.eyebrow}>STEP 4 OF 4 · HAND OVER</Text>
        <Text style={st.h1}>Enter delivery PIN</Text>
        <Text style={st.sub}>Ask {order.receiver_name} for the 4-digit PIN on their tracking page.</Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 12 }} accessibilityLabel={`PIN entered: ${pin.length} of 4 digits`}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={[st.pinBox, { borderColor: i === pin.length ? c.cobalt : i < pin.length ? c.ink : c.line, borderWidth: i === pin.length ? 3 : 2 }]}>
            <Text style={[mono, { fontSize: 32 }]}>{pin[i] ?? ''}</Text>
          </View>
        ))}
      </View>
      {error ? (
        <Text style={{ color: c.problem, fontWeight: '600' }}>{error}</Text>
      ) : (
        <Text style={st.note}>
          {online ? 'The PIN is checked on this phone and confirmed with Waybill.' : 'No signal is fine. The PIN is checked on this phone now and confirmed with Waybill when you are back online.'}
        </Text>
      )}
      <View style={st.keypad}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k, i) =>
          k === '' ? (
            <View key={i} style={st.key} />
          ) : (
            <Pressable
              key={i}
              accessibilityRole="button"
              accessibilityLabel={k === 'del' ? 'Delete digit' : k}
              onPress={() => press(k)}
              style={({ pressed }) => [st.key, st.keyBtn, pressed && { backgroundColor: c.cobaltTint }]}
            >
              <Text style={{ fontSize: 24, fontWeight: '600' }}>{k === 'del' ? '⌫' : k}</Text>
            </Pressable>
          ),
        )}
      </View>
      <Button label="Confirm delivery" disabled={pin.length !== 4} onPress={() => void confirm()} />
      <Button label="Back" kind="link" onPress={onCancel} />
    </ScrollView>
  );
}

function ConflictScreen({ conflict, onDone }: { conflict: { message: string; serverStatus?: string; droppedActions: string[] }; onDone: () => void }) {
  const ACTION: Record<string, string> = {
    start_trip: 'Start trip',
    confirm_pickup: 'Confirm pickup',
    start_dropoff: 'Start drop-off',
    confirm_delivery: 'Confirm delivery',
    report_failed_attempt: 'Report failed attempt',
    confirm_return: 'Confirm return',
  };
  return (
    <ScrollView contentContainerStyle={st.screen}>
      <View style={{ width: 56, height: 56, borderRadius: 14, backgroundColor: c.problemSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 28, color: c.problem, fontWeight: '800' }}>!</Text>
      </View>
      <Text style={st.h1}>This order changed while you were offline</Text>
      <Text style={st.sub}>{explainConflict(conflict.serverStatus)}</Text>
      <Card>
        <View style={st.row}>
          <Text style={st.rowLabel}>Order now</Text>
          <Text style={st.rowValue}>{(conflict.serverStatus ?? 'changed').replace(/_/g, ' ').toLowerCase()}</Text>
        </View>
        <View style={[st.row, { borderBottomWidth: 0 }]}>
          <Text style={st.rowLabel}>Not applied</Text>
          <Text style={st.rowValue}>{conflict.droppedActions.map((a) => ACTION[a] ?? a).join(', ') || 'none'}</Text>
        </View>
      </Card>
      <Text style={st.sub}>If you already have the parcel, keep it safe and call dispatch. They'll tell you where to take it.</Text>
      <Button label="Back to jobs" onPress={onDone} />
    </ScrollView>
  );
}

function explainConflict(status?: string): string {
  switch (status) {
    case 'CANCELLED':
      return 'Dispatch cancelled this order. The steps you took offline were not recorded.';
    case 'PAID':
    case 'OFFERED':
      return 'This order was taken off you and is being given to another driver.';
    case 'DELIVERED':
      return 'This order is already marked delivered.';
    default:
      return 'The order was changed on the server, so the steps you took offline were not recorded.';
  }
}

function Stat({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={{ flex: 1, padding: 14, gap: 2, borderRightWidth: last ? 0 : 1, borderRightColor: c.lineSoft }}>
      <Text style={{ fontSize: 12, color: c.muted }}>{label}</Text>
      <Text style={[mono, { fontSize: 18 }]}>{value}</Text>
    </View>
  );
}

function Place({ kind, label, address }: { kind: 'pickup' | 'dropoff'; label: string; address: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <View
        style={
          kind === 'pickup'
            ? { width: 14, height: 14, marginTop: 3, borderRadius: 3, backgroundColor: c.ink }
            : { width: 14, height: 14, marginTop: 3, borderRadius: 7, borderWidth: 4, borderColor: c.ink }
        }
      />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 12, color: c.muted }}>{label}</Text>
        <Text style={{ fontSize: 15, fontWeight: '600' }}>{address}</Text>
      </View>
    </View>
  );
}

const area = (a: string) => a.split(',').pop()!.trim();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const st = StyleSheet.create({
  screen: { padding: 20, gap: 16, flexGrow: 1 },
  eyebrow: { fontSize: 13, fontWeight: '600', color: c.cobalt, letterSpacing: 0.5 },
  h1: { fontSize: 28, fontWeight: '700', color: c.ink, lineHeight: 33 },
  sub: { fontSize: 15, color: c.ink2, lineHeight: 21 },
  note: { fontSize: 14, color: c.ink2, lineHeight: 20 },
  input: { height: 52, borderWidth: 1, borderColor: c.line, borderRadius: 10, backgroundColor: c.surface, paddingHorizontal: 14, fontSize: 16 },
  pinBox: { flex: 1, height: 72, borderRadius: 12, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' },
  keypad: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  key: { width: '31.5%', height: 60, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  keyBtn: { backgroundColor: c.surface },
  row: { flexDirection: 'row', padding: 14, borderBottomWidth: 1, borderBottomColor: c.lineSoft, gap: 10 },
  rowLabel: { width: 110, fontSize: 13, color: c.muted },
  rowValue: { flex: 1, fontSize: 14, fontWeight: '600' },
});
