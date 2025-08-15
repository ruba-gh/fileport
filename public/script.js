const socket = io();

let myKey = '';
let linkedKey = '';

function makeKey() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// When connected to server, generate key and send it
socket.on('connect', () => {
    myKey = makeKey();
    document.getElementById('myKey').textContent = myKey;
    socket.emit('registerKey', myKey);
});

// Link device button click
document.getElementById('linkBtn').addEventListener('click', () => {
    linkedKey = document.getElementById('linkKeyInput').value.trim();
    if (linkedKey) {
        socket.emit('linkDevices', { myKey, linkedKey });
    }
});

// Receive link confirmation
socket.on('linkAccepted', (data) => {
    alert(`Linked with device: ${data.key}`);
});

// Upload file and send to linked device
document.getElementById('fileInput').addEventListener('change', (e) => {
    if (!linkedKey) {
        alert('Please link a device first!');
        return;
    }
    const files = e.target.files;
    for (let file of files) {
        const reader = new FileReader();
        reader.onload = () => {
            socket.emit('sendFile', {
                to: linkedKey,
                name: file.name,
                type: file.type,
                data: reader.result
            });
        };
        reader.readAsArrayBuffer(file);
    }
});

// Receive file
socket.on('receiveFile', (file) => {
    const box = document.getElementById('fileBox');
    const blob = new Blob([file.data], { type: file.type });
    const url = URL.createObjectURL(blob);
    
    const item = document.createElement('div');
    item.classList.add('file-item');
    
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.textContent = `📄 ${file.name}`;
    
    item.appendChild(link);
    box.appendChild(item);
});
