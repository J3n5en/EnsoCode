import { TitleBar } from '@/components/app/TitleBar';
import { ChatView } from '@/components/chat/ChatView';

export default function App() {
  return (
    <div className="flex h-screen flex-col">
      <TitleBar title="EnsoCode" />
      <ChatView />
    </div>
  );
}
